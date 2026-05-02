const amqplib = require('amqplib');
const logger = require('../logger');

let connection = null;
let channel = null;

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

/**
 * Connect to RabbitMQ and create a channel.
 * Retries up to 5 times with exponential backoff.
 */
async function connectQueue() {
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      connection = await amqplib.connect(RABBITMQ_URL);
      channel = await connection.createChannel();

      connection.on('error', (err) => {
        logger.error('RabbitMQ connection error', { error: err.message });
      });
      connection.on('close', () => {
        logger.warn('RabbitMQ connection closed');
        channel = null;
        connection = null;
      });

      logger.info('Connected to RabbitMQ');
      return channel;
    } catch (err) {
      logger.warn(`RabbitMQ connection attempt ${attempt}/${maxRetries} failed`, {
        error: err.message,
      });
      if (attempt === maxRetries) {
        logger.error('Could not connect to RabbitMQ after max retries');
        throw err;
      }
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

/**
 * Get the current RabbitMQ channel.
 * @returns {import('amqplib').Channel}
 */
function getChannel() {
  if (!channel) throw new Error('RabbitMQ channel not initialized. Call connectQueue() first.');
  return channel;
}

/**
 * Gracefully close the RabbitMQ connection.
 */
async function closeQueue() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    logger.info('RabbitMQ connection closed gracefully');
  } catch (err) {
    logger.error('Error closing RabbitMQ connection', { error: err.message });
  }
}

module.exports = { connectQueue, getChannel, closeQueue };
