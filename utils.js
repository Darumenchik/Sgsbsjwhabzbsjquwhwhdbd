const nodemailer = require('nodemailer');
const crypto = require('crypto');

function env(name, fallback = '') {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return String(v).replace(/\r/g, '').trim();
}

function createTransporter() {
  const SMTP_HOST = env('SMTP_HOST');
  const SMTP_PORT = Number(env('SMTP_PORT', '587'));
  const SMTP_USER = env('SMTP_USER');
  const SMTP_PASS = env('SMTP_PASS');
  const DISABLE_TLS_VERIFY =
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || env('DISABLE_TLS_VERIFY') === '1';

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP credentials are not configured');
  }

  const transport = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  };

  if (DISABLE_TLS_VERIFY) {
    transport.tls = {
      rejectUnauthorized: false,
    };
  }

  return nodemailer.createTransport(transport);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

module.exports = {
  createTransporter,
  validateEmail,
  hashCode,
  env,
};
