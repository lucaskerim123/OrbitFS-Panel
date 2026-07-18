import { query } from './db.js';
const result = await query('select username, role, status from users order by username');
console.log(JSON.stringify(result.rows));
process.exit(0);
