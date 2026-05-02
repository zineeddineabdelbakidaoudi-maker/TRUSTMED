const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');

const GRAPH_ANOMALY_CLUSTER_SIZE = parseInt(process.env.GRAPH_ANOMALY_CLUSTER_SIZE || '5', 10);
const GRAPH_ANOMALY_DENSITY_THRESHOLD = parseFloat(process.env.GRAPH_ANOMALY_DENSITY_THRESHOLD || '0.80');
const TRUST_VELOCITY_MAX_PER_DAY = parseInt(process.env.TRUST_VELOCITY_MAX_PER_DAY || '25', 10);
const TRUST_VELOCITY_WINDOW_DAYS = parseInt(process.env.TRUST_VELOCITY_WINDOW_DAYS || '3', 10);
const VOUCH_AGE_WEIGHT_SCALE = parseInt(process.env.VOUCH_AGE_WEIGHT_SCALE || '30', 10);
const DIVERSITY_MIN_CLUSTERS = parseInt(process.env.DIVERSITY_MIN_CLUSTERS || '2', 10);
const VOUCHING_REQUIRED_COUNT = parseInt(process.env.VOUCHING_REQUIRED_COUNT || '2', 10);

class TrustGraphService {
  /**
   * Run full graph analysis (v2).
   */
  async runFullAnalysis(db = pool) {
    logger.info('Starting Trust Graph Analysis v2');
    const graph = await this.buildVouchGraph(db);
    
    if (graph.nodes.size === 0) {
      logger.info('Trust Graph is empty, skipping analysis');
      return { nodes: 0, edges: 0, clusters_flagged: 0, ranks_updated: 0, velocity_flagged: 0, diversity_flagged: 0 };
    }

    // Phase 1: Existing analysis
    const clusters = await this.detectSybilClusters(graph, db);
    const ranks = await this.computePageRankTrust(graph, db);
    await this.detectCentralityAnomalies(graph, db);

    // Phase 2: Anti-slow-poisoning (v2)
    const weightsUpdated = await this.computeRelationshipAgeWeights(db);

    let diversityFlagged = 0;
    let velocityFlagged = 0;

    for (const practId of graph.nodes) {
      const vouchRes = await db.query('SELECT vouch_count FROM practitioners WHERE id = $1', [practId]);
      if (vouchRes.rows.length > 0 && vouchRes.rows[0].vouch_count > 0) {
        const divResult = await this.computeVouchDiversity(practId, graph, db);
        if (divResult.flagged) diversityFlagged++;
      }
      const velResult = await this.computeTrustVelocity(practId, db);
      if (velResult.flagged) velocityFlagged++;
    }

    await writeAuditLog({
      actorType: 'system',
      action: 'GRAPH_ANALYSIS_V2_COMPLETE',
      targetId: 'system',
      metadata: {
        nodes: graph.nodes.size, edges: graph.edgesCount,
        clusters_found: clusters.length, weights_updated: weightsUpdated,
        velocity_flagged: velocityFlagged, diversity_flagged: diversityFlagged,
      },
    });

    logger.info('Trust Graph Analysis v2 complete', {
      nodes: graph.nodes.size, edges: graph.edgesCount,
      clusters: clusters.length, velocityFlagged, diversityFlagged, weightsUpdated,
    });
    
    return {
      nodes: graph.nodes.size, edges: graph.edgesCount,
      clusters_flagged: clusters.length, ranks_updated: ranks.size,
      velocity_flagged: velocityFlagged, diversity_flagged: diversityFlagged,
    };
  }

  // ──────────────────────────────────────────────────
  // V2 METHOD 1: Trust Velocity Detection
  // ──────────────────────────────────────────────────
  async computeTrustVelocity(practitionerId, db) {
    try {
      const res = await db.query(
        `SELECT trust_score, recorded_at FROM trust_score_history
         WHERE practitioner_id = $1 AND recorded_at > NOW() - INTERVAL '1 day' * $2
         ORDER BY recorded_at ASC`,
        [practitionerId, TRUST_VELOCITY_WINDOW_DAYS]
      );

      if (res.rows.length < 2) {
        return { velocity: 0, flagged: false, max_allowed: TRUST_VELOCITY_MAX_PER_DAY };
      }

      const oldest = res.rows[0];
      const latest = res.rows[res.rows.length - 1];
      const daysDiff = Math.max(1, (new Date(latest.recorded_at) - new Date(oldest.recorded_at)) / 86400000);
      const velocity = (latest.trust_score - oldest.trust_score) / daysDiff;
      const flagged = velocity > TRUST_VELOCITY_MAX_PER_DAY;

      if (flagged) {
        const practRes = await db.query('SELECT risk_flags, risk_score FROM practitioners WHERE id = $1', [practitionerId]);
        if (practRes.rows.length > 0) {
          let risk_flags = practRes.rows[0].risk_flags || [];
          if (!risk_flags.some(f => f.signal === 'TRUST_VELOCITY_ANOMALY')) {
            risk_flags.push({
              signal: 'TRUST_VELOCITY_ANOMALY', severity: 'HIGH', risk_points: 40,
              details: { velocity, max_allowed: TRUST_VELOCITY_MAX_PER_DAY, window_days: TRUST_VELOCITY_WINDOW_DAYS }
            });
            await db.query(
              'UPDATE practitioners SET trust_velocity = $1, trust_velocity_flag = true, risk_score = risk_score + 40, risk_flags = $2 WHERE id = $3',
              [velocity, JSON.stringify(risk_flags), practitionerId]
            );
            await db.query(
              `INSERT INTO reviewer_queue (practitioner_id, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [practitionerId, 'TRUST_VELOCITY_ANOMALY']
            );
            await writeAuditLog({
              actorType: 'system', action: 'VELOCITY_FLAG', targetId: practitionerId,
              metadata: { velocity, max_allowed: TRUST_VELOCITY_MAX_PER_DAY },
            });
          }
        }
      } else {
        await db.query(
          'UPDATE practitioners SET trust_velocity = $1, trust_velocity_flag = false WHERE id = $2',
          [velocity, practitionerId]
        );
      }
      return { velocity, flagged, max_allowed: TRUST_VELOCITY_MAX_PER_DAY };
    } catch (err) {
      logger.error('computeTrustVelocity failed', { practitionerId, error: err.message });
      return { velocity: 0, flagged: false, max_allowed: TRUST_VELOCITY_MAX_PER_DAY };
    }
  }

  // ──────────────────────────────────────────────────
  // V2 METHOD 2: Relationship Age Weights
  // ──────────────────────────────────────────────────
  async computeRelationshipAgeWeights(db) {
    try {
      await db.query(
        `UPDATE practitioner_vouches SET
           relationship_age_days = EXTRACT(EPOCH FROM (NOW() - created_at))::INTEGER / 86400
         WHERE status = 'ACTIVE'`
      );

      const res = await db.query(
        `SELECT id, voucher_id, subject_id, vouch_weight, relationship_age_days
         FROM practitioner_vouches WHERE status = 'ACTIVE'`
      );

      let updated = 0;
      const affectedSubjects = new Set();

      for (const vouch of res.rows) {
        const ageDays = vouch.relationship_age_days || 0;
        const ageWeight = Math.min(1.5, Math.max(0.1, Math.log(1 + ageDays / VOUCH_AGE_WEIGHT_SCALE)));
        const baseWeight = parseFloat(vouch.vouch_weight) || 1.0;
        const newWeight = parseFloat((baseWeight * ageWeight).toFixed(4));

        await db.query('UPDATE practitioner_vouches SET vouch_weight = $1 WHERE id = $2', [newWeight, vouch.id]);
        affectedSubjects.add(vouch.subject_id);
        updated++;
      }

      // Recompute effective_vouch_strength for affected subjects
      for (const subjectId of affectedSubjects) {
        const vouchesRes = await db.query(
          `SELECT vouch_weight FROM practitioner_vouches WHERE subject_id = $1 AND status = 'ACTIVE'`,
          [subjectId]
        );
        let sumWeights = 0;
        for (const v of vouchesRes.rows) sumWeights += parseFloat(v.vouch_weight);
        const strength = Math.min(1.0, sumWeights / VOUCHING_REQUIRED_COUNT);

        const practRes = await db.query('SELECT badge_level FROM practitioners WHERE id = $1', [subjectId]);
        await db.query('UPDATE practitioners SET effective_vouch_strength = $1 WHERE id = $2', [strength, subjectId]);

        if (practRes.rows.length > 0 && practRes.rows[0].badge_level === 'FULLY_VERIFIED' && strength < 1.0) {
          await db.query(
            `UPDATE practitioners SET verification_status = 'VOUCHING_PENDING' WHERE id = $1 AND verification_status = 'FULLY_VERIFIED'`,
            [subjectId]
          );
          await writeAuditLog({
            actorType: 'system', action: 'VOUCH_WEIGHT_RECOMPUTED', targetId: subjectId,
            metadata: { new_strength: strength, reason: 'age_weight_decay' },
          });
          logger.warn('Vouch strength dropped below 1.0 after age weighting', { subjectId, strength });
        }
      }
      return updated;
    } catch (err) {
      logger.error('computeRelationshipAgeWeights failed', { error: err.message });
      return 0;
    }
  }

  // ──────────────────────────────────────────────────
  // V2 METHOD 3: Vouch Diversity Analysis
  // ──────────────────────────────────────────────────
  async computeVouchDiversity(practitionerId, graph, db) {
    try {
      const res = await db.query(
        `SELECT pv.voucher_id FROM practitioner_vouches pv WHERE pv.subject_id = $1 AND pv.status = 'ACTIVE'`,
        [practitionerId]
      );
      if (res.rows.length === 0) {
        return { diversity: 0, unique_clusters: 0, total_vouches: 0, flagged: false };
      }

      const clusterIds = new Set();
      for (const row of res.rows) {
        const clusterRes = await db.query('SELECT graph_cluster_id FROM practitioners WHERE id = $1', [row.voucher_id]);
        if (clusterRes.rows.length > 0 && clusterRes.rows[0].graph_cluster_id != null) {
          clusterIds.add(clusterRes.rows[0].graph_cluster_id);
        }
      }

      const totalVouches = res.rows.length;
      const uniqueClusters = clusterIds.size;
      const diversity = totalVouches > 0 ? uniqueClusters / totalVouches : 0;
      const flagged = uniqueClusters < DIVERSITY_MIN_CLUSTERS && totalVouches >= VOUCHING_REQUIRED_COUNT;

      if (flagged) {
        const practRes = await db.query('SELECT risk_flags, risk_score FROM practitioners WHERE id = $1', [practitionerId]);
        if (practRes.rows.length > 0) {
          let risk_flags = practRes.rows[0].risk_flags || [];
          if (!risk_flags.some(f => f.signal === 'LOW_VOUCH_DIVERSITY')) {
            risk_flags.push({
              signal: 'LOW_VOUCH_DIVERSITY', severity: 'MEDIUM', risk_points: 25,
              details: { diversity, unique_clusters: uniqueClusters, total_vouches: totalVouches }
            });
            await db.query(
              'UPDATE practitioners SET vouch_diversity_score = $1, slow_poison_risk = true, risk_score = risk_score + 25, risk_flags = $2 WHERE id = $3',
              [diversity, JSON.stringify(risk_flags), practitionerId]
            );
            await writeAuditLog({
              actorType: 'system', action: 'LOW_DIVERSITY_FLAG', targetId: practitionerId,
              metadata: { diversity, unique_clusters: uniqueClusters, total_vouches: totalVouches },
            });
          }
        }
      } else {
        await db.query(
          'UPDATE practitioners SET vouch_diversity_score = $1, slow_poison_risk = false WHERE id = $2',
          [diversity, practitionerId]
        );
      }
      return { diversity, unique_clusters: uniqueClusters, total_vouches: totalVouches, flagged };
    } catch (err) {
      logger.error('computeVouchDiversity failed', { practitionerId, error: err.message });
      return { diversity: 0, unique_clusters: 0, total_vouches: 0, flagged: false };
    }
  }

  // ──────────────────────────────────────────────────
  // EXISTING METHODS (unchanged logic)
  // ──────────────────────────────────────────────────
  async buildVouchGraph(db) {
    const res = await db.query(
      `SELECT voucher_id, subject_id, vouch_weight, created_at 
       FROM practitioner_vouches WHERE status = 'ACTIVE'`
    );
    const adjacency = new Map();
    const nodes = new Set();
    let edgesCount = 0;
    for (const row of res.rows) {
      nodes.add(row.voucher_id);
      nodes.add(row.subject_id);
      if (!adjacency.has(row.voucher_id)) adjacency.set(row.voucher_id, { outgoing: [], incoming: [] });
      if (!adjacency.has(row.subject_id)) adjacency.set(row.subject_id, { outgoing: [], incoming: [] });
      adjacency.get(row.voucher_id).outgoing.push({ to: row.subject_id, weight: parseFloat(row.vouch_weight) });
      adjacency.get(row.subject_id).incoming.push({ from: row.voucher_id, weight: parseFloat(row.vouch_weight) });
      edgesCount++;
    }
    return { nodes, edgesCount, adjacency };
  }

  async detectSybilClusters(graph, db) {
    let index = 0;
    const stack = [];
    const vIndex = new Map();
    const vLowlink = new Map();
    const vOnStack = new Map();
    const sccs = [];
    const strongconnect = (v) => {
      vIndex.set(v, index);
      vLowlink.set(v, index);
      index++;
      stack.push(v);
      vOnStack.set(v, true);
      const nodeData = graph.adjacency.get(v);
      if (nodeData) {
        for (const edge of nodeData.outgoing) {
          const w = edge.to;
          if (!vIndex.has(w)) {
            strongconnect(w);
            vLowlink.set(v, Math.min(vLowlink.get(v), vLowlink.get(w)));
          } else if (vOnStack.get(w)) {
            vLowlink.set(v, Math.min(vLowlink.get(v), vIndex.get(w)));
          }
        }
      }
      if (vLowlink.get(v) === vIndex.get(v)) {
        const scc = [];
        let w;
        do { w = stack.pop(); vOnStack.set(w, false); scc.push(w); } while (w !== v);
        sccs.push(scc);
      }
    };
    for (const v of graph.nodes) { if (!vIndex.has(v)) strongconnect(v); }

    const flaggedClusters = [];
    for (const scc of sccs) {
      const n = scc.length;
      if (n >= GRAPH_ANOMALY_CLUSTER_SIZE) {
        let innerEdges = 0;
        const sccSet = new Set(scc);
        for (const node of scc) {
          const outgoing = graph.adjacency.get(node)?.outgoing || [];
          for (const edge of outgoing) { if (sccSet.has(edge.to)) innerEdges++; }
        }
        const possibleEdges = n * (n - 1);
        const density = innerEdges / possibleEdges;
        if (density >= GRAPH_ANOMALY_DENSITY_THRESHOLD) {
          flaggedClusters.push({ members: scc, density });
          logger.warn('Sybil cluster detected', { size: n, density });
          const clusterId = Date.now();
          for (const member of scc) {
            await this._flagSybilMember(member, scc, density, db);
            await db.query('UPDATE practitioners SET graph_cluster_id = $1 WHERE id = $2', [clusterId, member]);
          }
          await writeAuditLog({
            actorType: 'system', action: 'SYBIL_CLUSTER_FLAGGED', targetId: 'system',
            metadata: { cluster_ids: scc, density, innerEdges, possibleEdges, clusterId },
          });
        }
      }
    }
    return flaggedClusters;
  }

  async _flagSybilMember(practitionerId, clusterMembers, density, db) {
    const practResult = await db.query('SELECT risk_flags, risk_score FROM practitioners WHERE id = $1', [practitionerId]);
    if (practResult.rows.length === 0) return;
    let risk_flags = practResult.rows[0].risk_flags || [];
    let risk_score = practResult.rows[0].risk_score || 0;
    const flagExists = risk_flags.some(f => f.signal === 'SYBIL_CLUSTER_DETECTED');
    if (!flagExists) {
      risk_flags.push({ signal: 'SYBIL_CLUSTER_DETECTED', severity: 'HIGH', risk_points: 50, details: { cluster_size: clusterMembers.length, density } });
      risk_score += 50;
      await db.query('UPDATE practitioners SET risk_score = $1, risk_flags = $2 WHERE id = $3', [risk_score, JSON.stringify(risk_flags), practitionerId]);
      await db.query(`INSERT INTO reviewer_queue (practitioner_id, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [practitionerId, 'SYBIL_CLUSTER']);
    }
  }

  async computePageRankTrust(graph, db) {
    const N = graph.nodes.size;
    const d = 0.85;
    const iterations = 50;
    let ranks = new Map();
    for (const v of graph.nodes) ranks.set(v, 1.0 / N);
    for (let i = 0; i < iterations; i++) {
      const newRanks = new Map();
      let diff = 0;
      for (const v of graph.nodes) {
        let rankSum = 0;
        const incoming = graph.adjacency.get(v)?.incoming || [];
        for (const edge of incoming) {
          const u = edge.from;
          const uOut = graph.adjacency.get(u)?.outgoing.length || 1;
          rankSum += ranks.get(u) / uOut;
        }
        const newRank = (1 - d) / N + d * rankSum;
        newRanks.set(v, newRank);
        diff += Math.abs(newRank - ranks.get(v));
      }
      ranks = newRanks;
      if (diff < 0.0001) break;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const [id, rank] of ranks.entries()) {
        await client.query('UPDATE practitioners SET graph_rank = $1, graph_analyzed_at = NOW() WHERE id = $2', [rank, id]);
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    return ranks;
  }

  async detectCentralityAnomalies(graph, db) {
    const centrality = new Map();
    for (const v of graph.nodes) centrality.set(v, 0);
    for (const s of graph.nodes) {
      const S = [];
      const P = new Map();
      const sigma = new Map();
      const d = new Map();
      for (const w of graph.nodes) { P.set(w, []); sigma.set(w, 0); d.set(w, -1); }
      sigma.set(s, 1); d.set(s, 0);
      const Q = [s];
      while (Q.length > 0) {
        const v = Q.shift(); S.push(v);
        const outgoing = graph.adjacency.get(v)?.outgoing || [];
        for (const edge of outgoing) {
          const w = edge.to;
          if (d.get(w) < 0) { Q.push(w); d.set(w, d.get(v) + 1); }
          if (d.get(w) === d.get(v) + 1) { sigma.set(w, sigma.get(w) + sigma.get(v)); P.get(w).push(v); }
        }
      }
      const delta = new Map();
      for (const w of graph.nodes) delta.set(w, 0);
      while (S.length > 0) {
        const w = S.pop();
        for (const v of P.get(w)) { delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w))); }
        if (w !== s) centrality.set(w, centrality.get(w) + delta.get(w));
      }
    }
    let sum = 0;
    for (const v of graph.nodes) sum += centrality.get(v);
    const mean = sum / (graph.nodes.size || 1);
    let sqSum = 0;
    for (const v of graph.nodes) sqSum += Math.pow(centrality.get(v) - mean, 2);
    const stdDev = Math.sqrt(sqSum / (graph.nodes.size || 1));
    for (const [v, cent] of centrality.entries()) {
      if (cent > mean + 3 * stdDev) {
        const practResult = await db.query('SELECT trust_score, risk_flags, risk_score FROM practitioners WHERE id = $1', [v]);
        if (practResult.rows.length > 0) {
          const pract = practResult.rows[0];
          if (pract.trust_score < 85) {
            let risk_flags = pract.risk_flags || [];
            if (!risk_flags.some(f => f.signal === 'ANOMALOUS_CENTRALITY')) {
              risk_flags.push({ signal: 'ANOMALOUS_CENTRALITY', severity: 'MEDIUM', risk_points: 25, details: { centrality: cent, threshold: mean + 3 * stdDev } });
              await db.query('UPDATE practitioners SET risk_score = risk_score + 25, risk_flags = $1 WHERE id = $2', [JSON.stringify(risk_flags), v]);
              logger.warn('Centrality anomaly flagged', { practitionerId: v, centrality: cent });
            }
          }
        }
      }
    }
  }
}

module.exports = TrustGraphService;
