import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import { fileURLToPath } from 'url';
import https from 'https';
import fs from 'fs';

import indexRouter from './routes/index.js';
import usersRouter from './routes/users.js';
import sqlite3 from 'sqlite3';

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
// 本機開發與 Render 部署則沿用專案內的 db/sqlite.db（Render 免費版重啟後會重置，預期行為）。
const isAzure = !!process.env.WEBSITE_SITE_NAME;
const dataDir = isAzure ? '/home/data' : path.join(__dirname, 'db');

if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'sqlite.db');
const db = new sqlite3.Database(dbPath, (err) => {
	if (err) {
		console.error('❌ 資料庫開啟失敗:', err.message);
	} else {
		console.log('✅ 資料庫成功開啟:', dbPath);
	}
});

db.run(`
	CREATE TABLE IF NOT EXISTS copper_prices (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		date       TEXT NOT NULL,
		price_usd  REAL NOT NULL,
		unit       TEXT NOT NULL DEFAULT 'USD/lb',
		source     TEXT,
		note       TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
	)
`, (err) => {
	if (err) console.error('❌ 建表失敗:', err.message);
	else console.log('✅ copper_prices table 已就緒');
});

db.run(`
	CREATE TABLE IF NOT EXISTS fetch_log (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
		status     TEXT NOT NULL,
		message    TEXT
	)
`, (err) => {
	if (err) console.error('❌ fetch_log 建表失敗:', err.message);
	else console.log('✅ fetch_log table 已就緒');
});

// ── 爬蟲核心：Yahoo Finance 歷史區間查詢 ──────────────────────
//
//  HG=F = LME 銅期貨，interval=1d 代表日線
//  period1 / period2 為 Unix timestamp（秒）
//  Yahoo Finance 最早可查詢至 1980-01-01
//
function fetchCopperRange(startDate, endDate) {
	return new Promise((resolve, reject) => {
		const p1 = Math.floor(new Date(startDate).getTime() / 1000);
		// endDate 加一天，確保當天收盤價也包含在內
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
					const timestamps = result.timestamp;           // Unix 秒
					const closes     = result.indicators?.quote?.[0]?.close;
					if (!timestamps || !closes) throw new Error('找不到價格資料');

					const rows = [];
					timestamps.forEach((ts, i) => {
						const price = closes[i];
						if (price == null || isNaN(price)) return; // 跳過 null（假日）
						// 轉換為 YYYY-MM-DD（以 UTC 日期為準）
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

// 今日單筆自動抓取（啟動時使用）
function fetchToday() {
	return new Promise((resolve, reject) => {
		const today = new Date().toISOString().slice(0, 10);
		db.get(
			"SELECT id FROM copper_prices WHERE date = ? AND source = 'Yahoo Finance (HG=F)'",
			[today],
			(err, row) => {
				if (err) return reject(err);
				if (row) return resolve({ skipped: true, reason: '今日已有自動抓取記錄' });

				fetchCopperRange(today, today).then((rows) => {
					if (rows.length === 0) return resolve({ skipped: true, reason: '今日尚無收盤價（可能為非交易日）' });
					const { date, price } = rows[0];
					db.run(
						"INSERT INTO copper_prices (date, price_usd, unit, source, note) VALUES (?, ?, 'USD/lb', 'Yahoo Finance (HG=F)', '自動抓取')",
						[date, price],
						function(err2) {
							if (err2) return reject(err2);
							db.run("INSERT INTO fetch_log (status, message) VALUES ('success', ?)",
								[`單日抓取：${date} ${price} USD/lb`]);
							resolve({ skipped: false, date, price });
						}
					);
				}).catch(reject);
			}
		);
	});
}

// ── REST API ────────────────────────────────────────────────────

// GET /api/prices
app.get('/api/prices', (req, res) => {
	const { start, end } = req.query;
	let sql = 'SELECT * FROM copper_prices WHERE 1=1';
	const params = [];
	if (start) { sql += ' AND date >= ?'; params.push(start); }
	if (end)   { sql += ' AND date <= ?'; params.push(end); }
	sql += ' ORDER BY date ASC, id ASC';

	db.all(sql, params, (err, rows) => {
		if (err) return res.status(500).json({ success: false, message: err.message });
		res.json({ success: true, count: rows.length, data: rows });
	});
});

// POST /api/prices — 手動新增
app.post('/api/prices', (req, res) => {
	const { date, price_usd, source, note } = req.body;
	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
		return res.status(400).json({ success: false, message: '日期格式應為 YYYY-MM-DD' });
	if (price_usd === undefined || isNaN(Number(price_usd)) || Number(price_usd) <= 0)
		return res.status(400).json({ success: false, message: '價格必須為正數' });

	db.run(
		"INSERT INTO copper_prices (date, price_usd, unit, source, note) VALUES (?, ?, 'USD/lb', ?, ?)",
		[date, Number(price_usd), source?.trim() || '手動輸入', note?.trim() || null],
		function(err) {
			if (err) return res.status(500).json({ success: false, message: err.message });
			res.status(201).json({ success: true, message: '新增成功', data: { id: this.lastID, date, price_usd: Number(price_usd) } });
		}
	);
});

// DELETE /api/prices/:id
app.delete('/api/prices/:id', (req, res) => {
	db.run('DELETE FROM copper_prices WHERE id = ?', [Number(req.params.id)], function(err) {
		if (err) return res.status(500).json({ success: false, message: err.message });
		if (this.changes === 0) return res.status(404).json({ success: false, message: '找不到該筆記錄' });
		res.json({ success: true, message: '已刪除' });
	});
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
	db.get(`
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
	`, [], (err, row) => {
		if (err) return res.status(500).json({ success: false, message: err.message });
		const change = (row.latest_price && row.oldest_price)
			? ((row.latest_price - row.oldest_price) / row.oldest_price * 100).toFixed(2)
			: null;
		res.json({ success: true, data: { ...row, change_pct: change } });
	});
});

// ── GET /api/fetch-range?start=YYYY-MM-DD&end=YYYY-MM-DD ──────
//  批次抓取指定日期區間的歷史銅價，已存在的日期自動跳過
//  支援 start=1980-01-01（Yahoo Finance 最早可查）
app.get('/api/fetch-range', (req, res) => {
	const { start, end } = req.query;
	if (!start || !end)
		return res.status(400).json({ success: false, message: '請提供 start 和 end 參數（YYYY-MM-DD）' });
	if (start > end)
		return res.status(400).json({ success: false, message: 'start 不能晚於 end' });

	// 驗證日期格式
	if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
		return res.status(400).json({ success: false, message: '日期格式應為 YYYY-MM-DD' });

	console.log(`[爬蟲] 開始抓取區間 ${start} ~ ${end}`);

	fetchCopperRange(start, end).then((rows) => {
		if (rows.length === 0) {
			db.run("INSERT INTO fetch_log (status, message) VALUES ('success', ?)",
				[`區間 ${start}~${end} 無交易日資料`]);
			return res.json({ success: true, inserted: 0, skipped: 0, message: '該區間內無交易日資料' });
		}

		// 查詢區間內已存在的日期，避免重複寫入
		db.all(
			"SELECT date FROM copper_prices WHERE date >= ? AND date <= ? AND source = 'Yahoo Finance (HG=F)'",
			[start, end],
			(err, existing) => {
				if (err) return res.status(500).json({ success: false, message: err.message });

				const existSet = new Set(existing.map(r => r.date));
				const toInsert = rows.filter(r => !existSet.has(r.date));
				const skipped  = rows.length - toInsert.length;

				if (toInsert.length === 0) {
					db.run("INSERT INTO fetch_log (status, message) VALUES ('success', ?)",
						[`區間 ${start}~${end}：${skipped} 筆已存在，無需重複寫入`]);
					return res.json({ success: true, inserted: 0, skipped, message: `區間內 ${skipped} 筆已存在，無需重複寫入` });
				}

				// 批次寫入（使用 serialize 確保正確順序）
				db.serialize(() => {
					const stmt = db.prepare(
						"INSERT INTO copper_prices (date, price_usd, unit, source, note) VALUES (?, ?, 'USD/lb', 'Yahoo Finance (HG=F)', '區間批次抓取')"
					);
					toInsert.forEach(({ date, price }) => {
						stmt.run([date, price], (err2) => {
							if (err2) console.error('❌ 批次寫入失敗:', err2.message);
						});
					});
					stmt.finalize((finalErr) => {
						if (finalErr) {
							console.error('❌ finalize 失敗:', finalErr.message);
							return res.status(500).json({ success: false, message: finalErr.message });
						}
						const logMsg = `區間抓取 ${start}~${end}：新增 ${toInsert.length} 筆，跳過 ${skipped} 筆`;
						console.log(`[爬蟲] ${logMsg}`);
						db.run("INSERT INTO fetch_log (status, message) VALUES ('success', ?)", [logMsg]);
						res.json({
							success: true,
							inserted: toInsert.length,
							skipped,
							message: `成功寫入 ${toInsert.length} 筆，跳過已存在 ${skipped} 筆`,
							data: toInsert
						});
					});
				});
			}
		);
	}).catch((e) => {
		const errMsg = `區間抓取失敗 ${start}~${end}：${e.message}`;
		console.error(`[爬蟲] ${errMsg}`);
		db.run("INSERT INTO fetch_log (status, message) VALUES ('error', ?)", [errMsg]);
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
			db.run("INSERT INTO fetch_log (status, message) VALUES ('error', ?)", [e.message]);
			res.status(502).json({ success: false, message: `抓取失敗：${e.message}` });
		});
});

// GET /api/fetch-log
app.get('/api/fetch-log', (req, res) => {
	db.all('SELECT * FROM fetch_log ORDER BY id DESC LIMIT 20', [], (err, rows) => {
		if (err) return res.status(500).json({ success: false, message: err.message });
		res.json({ success: true, data: rows });
	});
});

// 啟動時自動抓今日
setTimeout(() => {
	fetchToday()
		.then(r => console.log(r.skipped ? `[爬蟲] ${r.reason}` : `[爬蟲] 啟動自動抓取：${r.price} USD/lb`))
		.catch(e => console.warn('[爬蟲] 啟動時抓取失敗：', e.message));
}, 1000);

export default app;
