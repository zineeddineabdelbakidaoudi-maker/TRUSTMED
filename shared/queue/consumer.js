const { getChannel } = require('./connection');
const { DOCUMENT_QUEUE } = require('./publisher');
const logger = require('../logger');

/**
 * Start consuming PROCESS_DOCUMENTS jobs from the queue.
 * In Phase 2 this logs the job; OCR integration comes in Phase 3.
 */
async function startConsumer() {
  try {
    const channel = getChannel();
    await channel.assertQueue(DOCUMENT_QUEUE, { durable: true });
    channel.prefetch(1);

    logger.info(`Waiting for messages on queue: ${DOCUMENT_QUEUE}`);

    channel.consume(DOCUMENT_QUEUE, (msg) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString());
        logger.info('Received PROCESS_DOCUMENTS job', {
          type: content.type,
          practitionerId: content.payload?.practitionerId,
          documentId: content.payload?.documentId,
          timestamp: content.timestamp,
        });

        // Phase 3: OCR processing will be implemented here.
        // For now, acknowledge the message after logging.
        channel.ack(msg);

        logger.info('PROCESS_DOCUMENTS job acknowledged', {
          practitionerId: content.payload?.practitionerId,
        });
      } catch (parseErr) {
        logger.error('Failed to parse queue message', { error: parseErr.message });
        channel.nack(msg, false, false); // reject, do not requeue
      }
    });
  } catch (err) {
    logger.error('Failed to start document processing consumer', { error: err.message });
    throw err;
  }
}

module.exports = { startConsumer };
