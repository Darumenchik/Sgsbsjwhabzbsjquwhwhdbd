/**
 * Test Neon Postgres connection for Chiper Messenger
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

async function testNeonConnection() {
  console.log('Testing Neon Postgres connection...\n');
  try {
    const db = require('./db');
    const ok = await db.healthCheck();
    console.log('Health check:', ok ? '✓ OK' : '✗ FAILED');

    const profiles = await db.many('SELECT id, email, username FROM profiles LIMIT 5');
    console.log('Profiles sample:', profiles);

    const tables = await db.many(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
    );
    console.log('Tables:', tables.map((t) => t.tablename).join(', '));

    console.log('\n✓ Connection successful!');
    await db.pool.end();
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    process.exit(1);
  }
}

testNeonConnection();
