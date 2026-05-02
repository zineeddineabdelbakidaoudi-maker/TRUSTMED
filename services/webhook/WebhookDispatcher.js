const axios = require('axios');
const hmac = require('../../shared/crypto/hmac');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');

const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 5000;
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES, 10) || 3;

/**
 * WebhookDispatcher — Sends HMAC-SHA256 signed POST requests
 * to partner webhook URLs when practitioner status changes.
 */
class WebhookDispatcher {
  /**
   * Dispatch a webhook to a partner.
   *
   * @param {object} params
   * @param {string} params.url      - Partner's webhook URL
   * @param {string} params.secret   - Partner's webhook secret (HMAC key)
   * @param {object} params.payload  - Event payload
   */
  async dispatch({ url, secret, payload }) {
    if (!url) {
      logger.debug('No webhook URL configured, skipping dispatch');
      return;
    }

    const body = JSON.stringify(payload);
    const hmacSecret = secret || process.env.HMAC_SECRET;
    const signature = hmac.sign(body, hmacSecret);

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-TrustMed-Signature': signature,
            'X-TrustMed-Event': payload.event || 'unknown',
            'X-TrustMed-Timestamp': payload.timestamp || new Date().toISOString(),
          },
          timeout: WEBHOOK_TIMEOUT,
        });

        logger.info('Webhook dispatched successfully', {
          url,
          event: payload.event,
          practitionerId: payload.practitioner_id,
          statusCode: response.status,
          attempt,
        });

        // Audit log
        await writeAuditLog({
          actorType: 'system',
          action: 'WEBHOOK_DISPATCHED',
          targetId: payload.practitioner_id,
          metadata: {
            url,
            event: payload.event,
            statusCode: response.status,
            attempt,
          },
        });

        return response;
      } catch (err) {
        lastError = err;
        logger.warn(`Webhook attempt ${attempt}/${MAX_RETRIES} failed`, {
          url,
          error: err.message,
          statusCode: err.response?.status,
        });

        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 1s, 2s, 4s...
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted
    logger.error('Webhook dispatch failed after all retries', {
      url,
      event: payload.event,
      practitionerId: payload.practitioner_id,
      error: lastError?.message,
    });

    await writeAuditLog({
      actorType: 'system',
      action: 'WEBHOOK_DISPATCH_FAILED',
      targetId: payload.practitioner_id,
      metadata: {
        url,
        event: payload.event,
        error: lastError?.message,
        maxRetries: MAX_RETRIES,
      },
    });
  }
}

module.exports = WebhookDispatcher;
