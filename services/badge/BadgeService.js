const pool = require('../../shared/db/pool');
const logger = require('../../shared/logger');

const BADGE_COLORS = {
  NONE: '#9ca3af', // grey
  IDENTITY_VERIFIED: '#3b82f6', // blue
  CNOM_CONFIRMED: '#0d9488', // teal
  CNOM_CONFIRMED_PLUS: '#16a34a', // green
  FULLY_VERIFIED: '#d97706', // gold
};

const BADGE_LABELS = {
  NONE: 'Non vérifié',
  IDENTITY_VERIFIED: 'Identité Vérifiée',
  CNOM_CONFIRMED: 'CNOM Confirmé',
  CNOM_CONFIRMED_PLUS: 'CNOM Confirmé +',
  FULLY_VERIFIED: 'Entièrement Vérifié',
};

const RISK_INDICATOR = {
  LOW:    { color: '#22c55e', label: 'Low Risk' },    // green
  MEDIUM: { color: '#eab308', label: 'Medium Risk' },  // yellow
  HIGH:   { color: '#ef4444', label: 'High Risk' },    // red
};

class BadgeService {
  async getBadgeData(practitioner_id) {
    try {
      const result = await pool.query(
        `SELECT id, trustmed_id, full_name, specialty, trust_score, badge_level,
                verified_at, risk_score, risk_flags, updated_at
         FROM practitioners WHERE id = $1`,
        [practitioner_id]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      return result.rows[0];
    } catch (err) {
      logger.error('Error fetching badge data', { error: err.message, practitioner_id });
      throw err;
    }
  }

  _getRiskLevel(riskScore) {
    if (riskScore >= 60) return 'HIGH';
    if (riskScore >= 30) return 'MEDIUM';
    return 'LOW';
  }

  generateSvg(badgeData) {
    const color = BADGE_COLORS[badgeData.badge_level] || BADGE_COLORS.NONE;
    const label = BADGE_LABELS[badgeData.badge_level] || BADGE_LABELS.NONE;
    const name = badgeData.full_name || 'Practitioner';
    const specialty = badgeData.specialty || '';
    const score = badgeData.trust_score || 0;
    const riskScore = badgeData.risk_score || 0;
    const riskLevel = this._getRiskLevel(riskScore);
    const riskInd = RISK_INDICATOR[riskLevel];

    // HIGH risk: badge border becomes red
    const borderColor = riskLevel === 'HIGH' ? '#ef4444' : color;
    const borderWidth = riskLevel === 'HIGH' ? 3 : 0;

    const shieldSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 22S4 18 4 10V5L12 2L20 5V10C20 18 12 22 12 22Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12L11 14L15 10" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    return `<svg width="280" height="80" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${color}" />
      <stop offset="100%" stop-color="${color}" stop-opacity="0.9" />
    </linearGradient>
  </defs>
  <rect width="280" height="80" rx="8" fill="url(#bg)" stroke="${borderColor}" stroke-width="${borderWidth}"/>
  
  <g transform="translate(10, 15)">
    ${shieldSvg}
  </g>
  
  <text x="50" y="30" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#ffffff">${name}</text>
  <text x="50" y="48" font-family="Arial, sans-serif" font-size="11" fill="#f3f4f6">${specialty}</text>
  
  <text x="270" y="30" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="end">${score}/100</text>
  <text x="270" y="48" font-family="Arial, sans-serif" font-size="10" fill="#f3f4f6" text-anchor="end">${label}</text>
  
  <circle cx="268" cy="68" r="5" fill="${riskInd.color}" stroke="#ffffff" stroke-width="1"/>
  
  <text x="140" y="70" font-family="Arial, sans-serif" font-size="9" fill="#e5e7eb" text-anchor="middle" letter-spacing="1">TRUSTMED.DZ</text>
</svg>`;
  }

  generateJson(badgeData) {
    const domain = process.env.DOMAIN || 'localhost:8000';
    const riskScore = badgeData.risk_score || 0;
    const riskLevel = this._getRiskLevel(riskScore);

    return {
      practitioner_id: badgeData.id,
      trustmed_id: badgeData.trustmed_id,
      full_name: badgeData.full_name,
      specialty: badgeData.specialty,
      trust_score: badgeData.trust_score,
      badge_level: badgeData.badge_level,
      verified_at: badgeData.verified_at,
      badge_label: BADGE_LABELS[badgeData.badge_level] || BADGE_LABELS.NONE,
      badge_color: BADGE_COLORS[badgeData.badge_level] || BADGE_COLORS.NONE,
      risk_score: riskScore,
      risk_level: riskLevel,
      risk_assessed_at: badgeData.updated_at,
      embed_url: `https://${domain}/v1/badge/${badgeData.id}.svg`
    };
  }

  generateWidgetScript(practitioner_id, badgeData) {
    const domain = process.env.DOMAIN || 'localhost:8000';
    const svgStr = this.generateSvg(badgeData).replace(/'/g, "\\'").replace(/\n/g, "");
    
    return `(function() {
  const svgContent = '${svgStr}';
  const container = document.createElement('div');
  const link = document.createElement('a');
  link.href = 'https://${domain}/verify/${practitioner_id}';
  link.target = '_blank';
  link.style.textDecoration = 'none';
  link.innerHTML = svgContent;
  container.appendChild(link);
  
  const currentScript = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  
  if (currentScript && currentScript.parentNode) {
    currentScript.parentNode.insertBefore(container, currentScript.nextSibling);
  } else {
    document.body.appendChild(container);
  }
})();`;
  }
}

module.exports = BadgeService;
