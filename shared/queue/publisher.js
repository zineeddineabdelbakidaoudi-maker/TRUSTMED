const { getChannel } = require('./connection');
const logger = require('../logger');

const DOCUMENT_QUEUE = 'document_processing';

/**
 * Publish a PROCESS_DOCUMENTS job to the document processing queue.
 * @param {object} payload - Job payload
 * @param {string} payload.practitionerId - UUID
 * @param {string} payload.documentId     - UUID
 * @param {string} payload.docType        - Document type
 */
async function publishDocumentJob(payload) {
  const channel = getChannel();
  await channel.assertQueue(DOCUMENT_QUEUE, { durable: true });

  const message = {
    type: 'PROCESS_DOCUMENTS',
    payload,
    timestamp: new Date().toISOString(),
  };

  channel.sendToQueue(DOCUMENT_QUEUE, Buffer.from(JSON.stringify(message)), {
    persistent: true,
    contentType: 'application/json',
  });

  logger.info('Published PROCESS_DOCUMENTS job', {
    practitionerId: payload.practitionerId,
    documentId: payload.documentId,
  });
}

module.exports = { publishDocumentJob, DOCUMENT_QUEUE };
