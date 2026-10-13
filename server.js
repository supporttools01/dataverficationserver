require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3000);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'replace-this-before-first-run')) {
  throw new Error('Set a unique ADMIN_PASSWORD before production startup');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined, max: 10 });
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  const ok = /\.txt$|\.csv$/i.test(file.originalname) && ['text/plain','text/csv','application/vnd.ms-excel','application/octet-stream'].includes(file.mimetype);
  cb(ok ? null : new Error('Only TXT or CSV files are accepted'), ok);
}});
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const signToken = user => jwt.sign({ sub: String(user.id), role: user.role, username: user.username }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'bitpro-data-box' });
const auth = asyncRoute(async (req,res,next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({ error:'Sign-in required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer:'bitpro-data-box' });
    const { rows } = await pool.query('SELECT id, username, role, active FROM users WHERE id=$1', [payload.sub]);
    if (!rows[0] || !rows[0].active) return res.status(401).json({ error:'Account unavailable' });
    req.user = rows[0]; next();
  } catch { return res.status(401).json({ error:'Invalid or expired session' }); }
});
const admin = (req,res,next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error:'Admin access required' });
const audit = (client, actor, action, type, id, details={}) => client.query('INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)',[actor,action,type,id,JSON.stringify(details)]);
const cleanName = name => String(name || 'upload.txt').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120);
function parseRows(text) {
  if (text.includes('\0')) throw new Error('File contains unsupported binary data');
  const lines = text.replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if (lines.length > 200000) throw new Error('Maximum 200,000 non-empty lines per upload');
  return [...new Set(lines)];
}
async function initialize() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')), active BOOLEAN NOT NULL DEFAULT TRUE, balance NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK(balance>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',category TEXT NOT NULL,price_per_10000 NUMERIC(18,6) NOT NULL DEFAULT 4 CHECK(price_per_10000>=0),enabled BOOLEAN NOT NULL DEFAULT TRUE,provider_mode TEXT NOT NULL DEFAULT 'demo' CHECK(provider_mode IN ('demo','authorized')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id),product_id TEXT NOT NULL REFERENCES products(id),name TEXT NOT NULL,region TEXT NOT NULL DEFAULT 'N/A',input_filename TEXT,input_data TEXT NOT NULL DEFAULT '',input_count INTEGER NOT NULL DEFAULT 0 CHECK(input_count>=0),status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','complete','failed')),mode TEXT NOT NULL DEFAULT 'demo' CHECK(mode IN ('demo','authorized')),cost NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK(cost>=0),result_filename TEXT,result_data TEXT,result_count INTEGER NOT NULL DEFAULT 0,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ledger (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id),task_id UUID REFERENCES tasks(id),amount NUMERIC(18,6) NOT NULL,entry_type TEXT NOT NULL CHECK(entry_type IN ('credit','debit','refund','adjustment')),note TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id BIGSERIAL PRIMARY KEY,actor_user_id BIGINT REFERENCES users(id),action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const products = [
    ['ios-status','iOS Status Workflow','Authorized-provider task intake; demo mode by default.','iOS',4],
    ['ios-dynamic','iOS Dynamic Status Workflow','Separate workflow; demo mode until an authorized provider is configured.','iOS',4],
    ['txt-validation','TXT File Validation','Local line and duplicate validation.','File tools',0],
    ['csv-validation','CSV File Validation','Local CSV structure validation.','File tools',0],
    ['number-format','Phone Number Format Audit','Syntax-only validation; no account-status lookup.','Data quality',0],
    ['email-format','Email Format Audit','Syntax-only validation; no mailbox existence lookup.','Data quality',0],
    ['data-dedup','Duplicate Record Cleanup','Deduplicate supplied datasets.','Data quality',0],
    ['custom-batch','Custom Batch Processing','Generic authorized batch intake. Demo mode by default.','Batch tools',4]
  ];
  for (const p of products) await pool.query('INSERT INTO products(id,name,description,category,price_per_10000) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',p);
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    const found = await pool.query('SELECT id FROM users WHERE username=$1',[username]);
    if (!found.rowCount) {
      const hash = await bcrypt.hash(password,12);
      await pool.query("INSERT INTO users(username,password_hash,role,balance) VALUES($1,$2,'admin',0)",[username,hash]);
      console.log('Initial admin created from environment configuration.');
    }
  }
}
app.get('/api/health', (_req,res)=>res.json({ok:true,service:'BitPro Data Box',providerMode:'demo',liveVerificationEnabled:false}));
app.post('/api/auth/login', asyncRoute(async (req,res)=>{
  const username = String(req.body.username || '').trim().slice(0,100);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({error:'Username and password are required'});
  const {rows} = await pool.query('SELECT id,username,password_hash,role,active FROM users WHERE username=$1',[username]);
  const user=rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:'Invalid credentials'});
  const token=signToken(user);
  await pool.query("INSERT INTO audit_logs(actor_user_id,action,target_type,target_id) VALUES($1,'login','user',$1)",[user.id]);
  res.json({token,user:{id:user.id,username:user.username,role:user.role}});
}));
app.get('/api/me',auth,asyncRoute(async(req,res)=>{
 const {rows}=await pool.query('SELECT id,username,role,balance,created_at FROM users WHERE id=$1',[req.user.id]);
 res.json({user:rows[0]});
}));
app.get('/api/products',auth,asyncRoute(async(_req,res)=>{
 const {rows}=await pool.query('SELECT id,name,description,category,price_per_10000,enabled,provider_mode FROM products WHERE enabled=true ORDER BY category,name');
 res.json({products:rows});
}));
app.post('/api/tasks',auth,upload.single('file'),asyncRoute(async(req,res)=>{
 const client=await pool.connect();
 try {
  const productId=String(req.body.productId||'').slice(0,80);
  const name=String(req.body.name||'').trim().slice(0,120);
  const region=String(req.body.region||'N/A').slice(0,80);
  if(!name) return res.status(400).json({error:'Task name is required'});
  let raw='';
  if(req.file) raw=req.file.buffer.toString('utf8');
  else raw=String(req.body.data||'');
  if(!raw.trim()) return res.status(400).json({error:'Upload a TXT/CSV file or provide records'});
  const records=parseRows(raw);
  const {rows:pRows}=await client.query('SELECT * FROM products WHERE id=$1 AND enabled=true',[productId]);
  const product=pRows[0]; if(!product) return res.status(400).json({error:'Unknown or disabled product'});
  const localOnly=['txt-validation','csv-validation','number-format','email-format','data-dedup'].includes(productId);
  const cost=localOnly?0:Number(product.price_per_10000)*records.length/10000;
  await client.query('BEGIN');
  const {rows:uRows}=await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
  if(!uRows[0] || Number(uRows[0].balance)<cost) {await client.query('ROLLBACK');return res.status(402).json({error:'Insufficient balance',estimatedCost:cost});}
  const id=crypto.randomUUID();
  await client.query('INSERT INTO tasks(id,user_id,product_id,name,region,input_filename,input_data,input_count,status,mode,cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,req.user.id,productId,name,region,req.file?cleanName(req.file.originalname):null,records.join('\n'),records.length,'queued','demo',0]);
  await audit(client,req.user.id,'task_created','task',id,{productId,records:records.length,mode:'manual_review'});
  await client.query('COMMIT');
  res.status(201).json({task:{id,name,productId,region,records:records.length,cost:0,status:'queued',mode:'manual_review',message:'Pending manual verification. No charge has been applied yet.'}});
 } catch(e) {try{await client.query('ROLLBACK')}catch{} throw e} finally {client.release()}
}));
app.get('/api/tasks',auth,asyncRoute(async(req,res)=>{
 const isAdmin=req.user.role==='admin';
 const {rows}=await pool.query(`SELECT t.id,t.name,t.product_id,t.region,t.input_filename,t.input_count,t.status,t.mode,t.cost,t.result_filename,t.result_count,t.created_at,t.completed_at,u.username,p.name AS product_name FROM tasks t JOIN users u ON u.id=t.user_id JOIN products p ON p.id=t.product_id ${isAdmin?'':'WHERE t.user_id=$1'} ORDER BY t.created_at DESC LIMIT 500`,isAdmin?[]:[req.user.id]);
 res.json({tasks:rows});
}));
app.get('/api/tasks/:id/download/:kind',auth,asyncRoute(async(req,res)=>{
 const kind=req.params.kind;
 if(!['input','results'].includes(kind)) return res.status(400).json({error:'Download type must be input or results'});
 const {rows}=await pool.query('SELECT id,user_id,name,input_filename,input_data,result_filename,result_data FROM tasks WHERE id=$1',[req.params.id]);
 const t=rows[0]; if(!t)return res.status(404).json({error:'Task not found'});
 if(req.user.role!=='admin' && String(t.user_id)!==String(req.user.id))return res.status(403).json({error:'Not allowed'});
 const data=kind==='input'?t.input_data:t.result_data;
 if(data==null)return res.status(404).json({error:'File not available'});
 const filename=kind==='input'?(t.input_filename||'input.txt'):(t.result_filename||'results.csv');
 res.setHeader('Content-Type','text/csv; charset=utf-8');
 res.setHeader('Content-Disposition','attachment; filename="'+cleanName(filename)+'"');
 res.send(data);
}));
app.get('/api/admin/users',auth,admin,asyncRoute(async(_req,res)=>{
 const {rows}=await pool.query('SELECT id,username,role,active,balance,created_at FROM users ORDER BY created_at DESC LIMIT 1000');res.json({users:rows});
}));
app.post('/api/admin/users',auth,admin,asyncRoute(async(req,res)=>{
 const username=String(req.body.username||'').trim();
 const password=String(req.body.password||'');
 const role=req.body.role==='admin'?'admin':'user';
 const balance=Math.max(0,Math.min(1000000,Number(req.body.balance)||0));
 if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username))return res.status(400).json({error:'Username must be 3–40 letters, numbers, dot, underscore or hyphen'});
 if(password.length<12)return res.status(400).json({error:'Initial password must be at least 12 characters'});
 const hash=await bcrypt.hash(password,12);
 const client=await pool.connect();
 try {await client.query('BEGIN');const {rows}=await client.query('INSERT INTO users(username,password_hash,role,balance) VALUES($1,$2,$3,$4) RETURNING id,username,role,active,balance,created_at',[username,hash,role,balance]);if(balance>0)await client.query("INSERT INTO ledger(user_id,amount,entry_type,note) VALUES($1,$2,'credit','Initial admin-issued balance')",[rows[0].id,balance]);await audit(client,req.user.id,'user_created','user',rows[0].id,{username,role,balance});await client.query('COMMIT');res.status(201).json({user:rows[0]});}
 catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'Username already exists'});throw e}finally{client.release()}
}));
app.patch('/api/admin/users/:id',auth,admin,asyncRoute(async(req,res)=>{
 const id=Number(req.params.id);if(!Number.isSafeInteger(id))return res.status(400).json({error:'Invalid user ID'});
 if(req.body.active===undefined)return res.status(400).json({error:'Provide active true or false'});
 if(String(id)===String(req.user.id)&&req.body.active===false)return res.status(400).json({error:'Cannot disable your own active admin session'});
 const {rows}=await pool.query('UPDATE users SET active=$1 WHERE id=$2 RETURNING id,username,role,active,balance',[Boolean(req.body.active),id]);if(!rows[0])return res.status(404).json({error:'User not found'});
 await pool.query('INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)',[req.user.id,'user_status_updated','user',id,JSON.stringify({active:!!req.body.active})]);res.json({user:rows[0]});
}));
app.post('/api/admin/users/:id/balance',auth,admin,asyncRoute(async(req,res)=>{
 const id=Number(req.params.id),amount=Number(req.body.amount),note=String(req.body.note||'Admin balance adjustment').slice(0,200);
 if(!Number.isSafeInteger(id)||!Number.isFinite(amount)||amount===0||Math.abs(amount)>1000000)return res.status(400).json({error:'Provide a valid non-zero adjustment amount'});
 const client=await pool.connect();
 try{await client.query('BEGIN');const {rows}=await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE',[id]);if(!rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'User not found'})}if(Number(rows[0].balance)+amount<0){await client.query('ROLLBACK');return res.status(400).json({error:'Adjustment would make balance negative'})}const updated=await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING id,username,balance',[amount,id]);await client.query('INSERT INTO ledger(user_id,amount,entry_type,note) VALUES($1,$2,$3,$4)',[id,Math.abs(amount),amount>0?'credit':'adjustment',note]);await audit(client,req.user.id,'balance_adjusted','user',id,{amount,note});await client.query('COMMIT');res.json({user:updated.rows[0]})}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
}));
app.get('/api/admin/ledger',auth,admin,asyncRoute(async(_req,res)=>{const {rows}=await pool.query('SELECT l.*,u.username FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 1000');res.json({ledger:rows})}));
app.get('/api/admin/audit',auth,admin,asyncRoute(async(_req,res)=>{const {rows}=await pool.query('SELECT a.*,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 500');res.json({audit:rows})}));
app.post('/api/admin/tasks/:id/results',auth,admin,upload.single('file'),asyncRoute(async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'Upload a TXT or CSV result file'});
 const data=req.file.buffer.toString('utf8');if(data.includes('\0'))return res.status(400).json({error:'Invalid text file'});
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const {rows:taskRows}=await client.query('SELECT id,user_id,input_count,status FROM tasks WHERE id=$1 FOR UPDATE',[req.params.id]);
  const task=taskRows[0];
  if(!task){await client.query('ROLLBACK');return res.status(404).json({error:'Task not found'})}
  if(task.status==='complete'){await client.query('ROLLBACK');return res.status(409).json({error:'This task is already completed. Create a new task for a replacement result.'})}
  const {rows:userRows}=await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE',[task.user_id]);
  const {rows:productRows}=await client.query('SELECT price_per_10000 FROM products WHERE id=(SELECT product_id FROM tasks WHERE id=$1)',[task.id]);
  const freeProducts=['txt-validation','csv-validation','number-format','email-format','data-dedup'];
  const {rows:taskProduct}=await client.query('SELECT product_id FROM tasks WHERE id=$1',[task.id]);
  const charge=freeProducts.includes(taskProduct[0].product_id)?0:Number(productRows[0].price_per_10000)*Number(task.input_count)/10000;
  if(Number(userRows[0].balance)<charge){await client.query('ROLLBACK');return res.status(402).json({error:'User has insufficient balance to complete and charge this task',required:charge,balance:Number(userRows[0].balance)})}
  const {rows}=await client.query('UPDATE tasks SET result_filename=$1,result_data=$2,result_count=$3,mode=$4,status=$5,cost=$6,completed_at=NOW() WHERE id=$7 RETURNING id,user_id,name,result_filename,result_count,status,cost',[cleanName(req.file.originalname),data,parseRows(data).length,'manual_review','complete',charge,req.params.id]);
  if(charge>0){
    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2',[charge,task.user_id]);
    await client.query("INSERT INTO ledger(user_id,task_id,amount,entry_type,note) VALUES($1,$2,$3,'debit',$4)",[task.user_id,task.id,charge,'Manual verification task completed; rate is 4 USDT per 10,000 records']);
  }
  await audit(client,req.user.id,'manual_results_uploaded','task',req.params.id,{filename:cleanName(req.file.originalname),bytes:req.file.size,charge,mode:'manual_review'});
  await client.query('COMMIT');
  res.json({task:rows[0],notice:'Result file uploaded by admin. Billing was applied at completion when applicable; the portal does not independently certify file contents.'});
 } catch(e){try{await client.query('ROLLBACK')}catch{}throw e} finally{client.release()}
}));
app.get('/api/admin/tasks/:id/input',auth,admin,asyncRoute(async(req,res)=>{const {rows}=await pool.query('SELECT input_filename,input_data FROM tasks WHERE id=$1',[req.params.id]);if(!rows[0])return res.status(404).json({error:'Task not found'});res.setHeader('Content-Disposition','attachment; filename="'+cleanName(rows[0].input_filename||'input.txt')+'"');res.type('text/plain').send(rows[0].input_data)}));
app.use(express.static(path.join(__dirname,'public')));
app.get('/',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html'),err=>{if(err)res.status(200).sendFile(path.join(__dirname,'index.html'))}));
app.get('/admin',(_req,res)=>res.sendFile(path.join(__dirname,'public','admin.html'),err=>{if(err)res.status(200).sendFile(path.join(__dirname,'admin.html'))}));
app.use((err,_req,res,_next)=>{if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File too large':err.message});if(err.message==='Only TXT or CSV files are accepted')return res.status(400).json({error:err.message});console.error(err);res.status(500).json({error:'Server error'});});
initialize().then(()=>app.listen(port,()=>console.log('BitPro Data Box listening on '+port))).catch(err=>{console.error('Startup failed',err);process.exit(1)});
