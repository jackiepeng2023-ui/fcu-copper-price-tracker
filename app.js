import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import { fileURLToPath } from 'url';
import https from 'https';
import fs from 'fs';
import Database from 'better-sqlite3';

import indexRouter from './routes/index.js';
import usersRouter from './routes/users.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

var app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);

// ── SQLite3 初始化 ──────────────────────────────────────────────
// Azure App Service 只有 /home 資料夾會在重啟、重新部署後持久保存，
// 因此用 WEBSITE_SITE_NAME（Azure 自動注入的環境變數）判斷是否在 Azure 上執行。
const isAzure = !!process.env.WEBSITE_SITE_NAME;
const dataDir = isAzure ? '/home/data' : path.join(__dirname, 'db');

if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'sqlite.db');
let db;
try {
	db = new Database(dbPath);
	console.log('✅ 資料庫成功開啟:', dbPath);
} catch (err) {
	console.error('❌ 資料庫開啟失敗:', err.message);
	process.exit(1);
}

db.exec(`
	CREATE TABLE IF NOT EXISTS copper_prices (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		date       TEXT NOT NULL,
		price_usd  REAL NOT NULL,
		unit       TEXT NOT NULL DEFAULT 'USD/lb',
		source     TEXT,
		note       TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
	)
`);
console.log('✅ copper_prices table 已就緒');

db.exec(`
	CREATE TABLE IF NOT EXISTS fetch_log (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
		status     TEXT NOT NULL,
		message    TEXT
	)
`);
console.log('✅ fetch_log table 已就緒');

// ── 爬蟲核心：Yahoo Finance 歷史區間查詢 ──────────────────────
function fetchCopperRange(startDate, endDate) {
	return new Promise((resolve, reject) => {
		const p1 = Math.floor(new Date(startDate).getTime() / 1000);
		const p2 = Math.floor(new Date(endDate).getTime() / 1000) + 86400;
		const url = `https://query1.finance.yahoo.com/v8/finance/chart/HG%3DF?interval=1d&period1=${p1}&period2=${p2}`;
		const options = {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; copper-tracker/1.0)' }
		};
		https.get(url, options, (res) => {
			let raw = '';
			res.on('data', (chunk) => { raw += chunk; });
			res.on('end', () => {
				try {
					const json      = JSON.parse(raw);
					const result    = json?.chart?.result?.[0];
					if (!result) throw new Error('回應結構異常');
					const timestamps = result.timestamp;
					const closes     = result.indicators?.quote?.[0]?.close;
					if (!timestamps || !closes) throw new Error('找不到價格資料');

					const rows = [];
					timestamps.forEach((ts, i) => {
						const price = closes[i];
						if (price == null || isNaN(price)) return;
						const d = new Date(ts * 1000);
						const dateStr = d.toISOString().slice(0, 10);
						rows.push({ date: dateStr, price: Math.round(price * 10000) / 10000 });
					});
					resolve(rows);
				} catch (e) {
					reject(e);
				}
			});
		}).on('error', reject);
	});
}

// 今日單筆自動抓取
function fetchToday() {
	return new Promise((resolve, reject) => {
		try {
			const today = new Date().toISOString().slice(0, 10);
			const existing = db.prepare(
				"SELECT id FROM copper_prices WHERE date = ? AND source = 'Yahoo Finance (HG=F)'"
			).get(today);

			if (existing) return resolve({ skipped: true, reason: '今日已有自動抓取記錄' });

			fetchCopperRange(today, today).then((rows) => {
				if (rows.length === 0) return resolve({ skipped: true, reason: '今日尚無收盤價（可能為非交易日）' });
				const { date, price } = rows[0];
				db.prepare(
					"INSERT INTO copper_prices (date, price_usd, unit, source, note) VALUES (?, ?, 'USD/lb', 'Yahoo Finance (HG=F)', '自動抓取')"
				).run(date, price);
				db.prepare("INSERT INTO fetch_log (status, message) VALUES ('success', ?)").run(
					`單日抓取：${date} ${price} USD/lb`
				);
				resolve({ skipped: false, date, price });
			}).catch(reject);
		} catch (err) {
			reject(err);
		}
	});
}

// ── REST API ────────────────────────────────────────────────────

// GET /api/prices
app.get('/api/prices', (req, res) => {
	try {
		const { start, end } = req.query;
		let sql = 'SELECT * FROM copper_prices WHERE 1=1';
		const params = [];
		if (start) { sql += ' AND date >= ?'; params.push(start); }
		if (end)   { sql += ' AND date <= ?'; params.push(end); }
		sql += ' ORDER BY date ASC, id ASC';
		const rows = db.prepare(sql).all(...params);
		res.json({ success: true, count: rows.length, data: rows });
	} catch (err) {
		res.status(500).json({ success: false, message: err.message });
	}
});

// POST /api/prices
app.post('/api/prices', (req, res) => {
	try {
		const { date, price_usd, source, note } = req.body;
		if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
			return res.status(400).json({ success: false, message: '日期格式應為 YYYY-MM-DD' });
		if (price_usd === undefined || isNaN(Number(price_usd)) || Number(price_usd) <= 0)
			return res.status(400).json({ success: false, message: '價格必須為正數' });

		const result = db.prepare(
			"INSERT INTO copper_prices (date, price_usd, unit, source, note) VALUES (?, ?, 'USD/lb', ?, ?)"
		).run(date, Number(price_usd), source?.trim() || '手動輸入', note?.trim() || null);

		res.status(201).json({ success: true, message: '新增成功', data: { id: result.lastInsertRowid, date, price_usd: Number(price_usd) } });
	} catch (err) {
		res.status(500).json({ success: false, message: err.message });
	}
});

// DELETE /api/prices/:id
app.delete('/api/prices/:id', (req, res) => {
	try {
		const result = db.prepare('DELETE FROM copper_prices WHERE id = ?').run(Number(req.params.id));
		if (result.changes === 0) return res.status(404).json({ success: false, message: '找不到該筆記錄' });
		res.json({ success: true, message: '已刪除' });
	} catch (err) {
		res.status(500).json({ success: false, message: err.message });
	}
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
	try {
		const row = db.prepare(`
			SELECT
				COUNT(*) AS count,
				MIN(price_usd) AS min_price,
				MAX(price_usd) AS max_price,
				ROUND(AVG(price_usd), 4) AS avg_price,
				(SELECT price_usd FROM copper_prices ORDER BY date DESC, id DESC LIMIT 1) AS latest_price,
				(SELECT date      FROM copper_prices ORDER BY date DESC, id DESC LIMIT 1) AS latest_date,
				(SELECT price_usd FROM copper_prices ORDER BY date ASC,  id ASC  LIMIT 1) AS oldest_price,
				(SELECT date      FROM copper_prices ORDER BY date ASC,  id ASC  LIMIT 1) AS oldest_date
			FROM copper_prices
		`).get();
		const change = (row.latest_price && row.oldest_price)
			? ((row.latest_price - row.oldest_price) / row.oldest_price * 100).toFixed(2)
			: null;
		res.json({ success: true, data: { ...row, change_pct: change } });
	} catch (err) {
		res.status(500).json({ success: false, message: err.message });
	}
});

// GET /api/fetch-range?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get('/api/fetch-range', (req, res) => {
	const { start, end } = req.query;
	if (!start || !end)
		return res.status(400).json({ success: false, message: '請提供 start 和 end 參數（YYYY-MM-DD）' });
	if (start > end)
		return res.status(400).json({ success: false, message: 'start 不能晚於 end' });
	if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
		return res.status(400).json({ success: false, message: '日期格式應為 YYYY-MM-DD' });

	console.log(`[爬蟲] 開始抓取區間 ${start} ~ ${end}`);

	fetchCopperRange(start, end).then((rows) => {
		if (rows.length === 0) {
			db.prepare("INSERT INTO fetch_log (status, message) VALUES ('success', ?)").run(
				`區間 ${start}~${end} 無交易日資料`
			);
			return res.json({ success: true, inserted: 0, skipped: 0, message: '該區間內無交易日資料' });
		}

		const existing = db.prepare(
			"SELECT date FROM copper_prices WHERE date >= ? AND date <= ? AND source = 'Yahoo Finance (HG=F)'"
		).all(start, end);

		const existSet = new Set(existing.map(r => r.date));
		const toInsert = rows.filter(r => !existSet.has(r.date));
		const skipped  = rows.length - toInsert.length;

		if (toInsert.length === 0) {
			db.prepare("INSERT INTO fetch_log (status, message) VALUES ('success', ?)").run(
				`區間 ${start}~${end}：${skipped} 筆已存在，無需重複寫入`
			);
			return res.json({ success: true, inserted: 0, skipped, message: `區間內 ${skipped} 筆已存在，無需重複寫入` });
		}

		const insertStmt = db.prepare(
			"INSERT INTO copper_prices (date, price_usd, unit, source, note) VALUES (?, ?, 'USD/lb', 'Yahoo Finance (HG=F)', '區間批次抓取')"
		);
		const insertMany = db.transaction((items) => {
			for (const { date, price } of items) insertStmt.run(date, price);
		});
		insertMany(toInsert);

		const logMsg = `區間抓取 ${start}~${end}：新增 ${toInsert.length} 筆，跳過 ${skipped} 筆`;
		console.log(`[爬蟲] ${logMsg}`);
		db.prepare("INSERT INTO fetch_log (status, message) VALUES ('success', ?)").run(logMsg);
		res.json({ success: true, inserted: toInsert.length, skipped, message: `成功寫入 ${toInsert.length} 筆，跳過已存在 ${skipped} 筆`, data: toInsert });

	}).catch((e) => {
		const errMsg = `區間抓取失敗 ${start}~${end}：${e.message}`;
		console.error(`[爬蟲] ${errMsg}`);
		db.prepare("INSERT INTO fetch_log (status, message) VALUES ('error', ?)").run(errMsg);
		res.status(502).json({ success: false, message: `抓取失敗：${e.message}` });
	});
});

// GET /api/fetch — 今日單筆
app.get('/api/fetch', (req, res) => {
	fetchToday()
		.then((result) => {
			if (result.skipped)
				return res.json({ success: true, skipped: true, message: result.reason });
			res.json({ success: true, skipped: false, message: `抓取成功：${result.price} USD/lb`, data: result });
		})
		.catch((e) => {
			db.prepare("INSERT INTO fetch_log (status, message) VALUES ('error', ?)").run(e.message);
			res.status(502).json({ success: false, message: `抓取失敗：${e.message}` });
		});
});

// GET /api/fetch-log
app.get('/api/fetch-log', (req, res) => {
	try {
		const rows = db.prepare('SELECT * FROM fetch_log ORDER BY id DESC LIMIT 20').all();
		res.json({ success: true, data: rows });
	} catch (err) {
		res.status(500).json({ success: false, message: err.message });
	}
});

// 啟動時自動抓今日
setTimeout(() => {
	fetchToday()
		.then(r => console.log(r.skipped ? `[爬蟲] ${r.reason}` : `[爬蟲] 啟動自動抓取：${r.price} USD/lb`))
		.catch(e => console.warn('[爬蟲] 啟動時抓取失敗：', e.message));
}, 1000);

export default app;
