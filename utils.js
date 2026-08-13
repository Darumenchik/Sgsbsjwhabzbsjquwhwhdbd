const nodemailer = require('nodemailer');
const crypto = require('crypto');                     

function env(name, fallback = '') {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return String(v).replace(/\r/g, '').trim();         
}

function createTransporter() {
  // Если хост не указан, по умолчанию стучимся в Google
  const SMTP_HOST = env('SMTP_HOST', 'smtp.gmail.com');                   
  const SMTP_PORT = 465; // Принудительно 465 порт для Render
  const SMTP_USER = env('SMTP_USER');
  const SMTP_PASS = env('SMTP_PASS');

  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP credentials are not configured in environment variables');
  }

  const transport = {
    host: SMTP_HOST,
    port: SMTP_PORT,                                      
    secure: true, // Строго true для порта 465
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false, // Всегда отключаем проверку, чтобы избежать блокировок хостинга
    },
    connectionTimeout: 10000, // Отваливаемся через 10 сек, если не можем подключиться (чтобы не висел pending)
  };

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

