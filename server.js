
const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
// WRAPPER DATABASE ASYNC (Agar Vercel stabil)
const db = {
    get: async (sql, params = []) => {
        const query = sql.replace(/\?/g, (match, index) => `$${params.indexOf(params[index]) + 1}`); 
        // Versi lebih aman:
        const formattedSql = sql.includes('$') ? sql : sql.replace(/\?/g, (_, i) => `$${i + 1}`);
        const res = await pool.query(formattedSql, params);
        return res.rows[0];
    },
    all: async (sql, params = []) => {
        const formattedSql = sql.includes('$') ? sql : sql.replace(/\?/g, (_, i) => `$${i + 1}`);
        const res = await pool.query(formattedSql, params);
        return res.rows;
    },
    run: async (sql, params = []) => {
        const formattedSql = sql.includes('$') ? sql : sql.replace(/\?/g, (_, i) => `$${i + 1}`);
        return await pool.query(formattedSql, params);
    }
};
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require('uuid');
const app = express();
const port = process.env.PORT || 3000;

// 1. KONFIGURASI DASAR
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

const pgSession = require('connect-pg-simple')(session);

app.use(session({
    secret: "tatriz_secret_key",
    resave: true, // Ubah ke true jika session sering hilang
    saveUninitialized: false,
    proxy: true, // Tambahkan ini agar Vercel mengenali session lewat HTTPS
    cookie: { 
        secure: true, // Set true jika pakai domain vercel.app (HTTPS)
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// 2. DATABASE INITIALIZATION (Async & Postgres Friendly)
const initDB = async () => {
    try {
        const pk = "SERIAL PRIMARY KEY"; 
        
        // Buat Tabel Settings
        await db.run(`CREATE TABLE IF NOT EXISTS settings (id ${pk}, tenant_id INTEGER UNIQUE, nama_aplikasi TEXT, nama_perusahaan TEXT, alamat TEXT, no_hp TEXT, logo_path TEXT, password_admin TEXT, target_bonus REAL DEFAULT 500000, nominal_bonus_dasar REAL DEFAULT 10000, kelipatan_bonus REAL DEFAULT 100000, nominal_bonus_lipat REAL DEFAULT 5000, pembagi_lembur REAL DEFAULT 4, nominal_buffer REAL DEFAULT 0, beban_tetap REAL DEFAULT 0, level INTEGER DEFAULT 1)`);

        // Buat Tabel Users
        await db.run(`CREATE TABLE IF NOT EXISTS users (id ${pk}, tenant_id INTEGER, username TEXT UNIQUE, password TEXT, nama_lengkap TEXT, role TEXT, gaji_pokok REAL DEFAULT 0)`);

        // Cek Admin Utama (Tenant 1)
        const checkUser = await db.get("SELECT count(*) as count FROM users");
        if (checkUser && Number(checkUser.count) === 0) {
            // Kita hash passwordnya agar bisa login (bcrypt)
            const hashedAdmin = await bcrypt.hash('admin123', 10);
            await db.run(`INSERT INTO users (tenant_id, username, password, nama_lengkap, role) VALUES (1, 'admin', ?, 'Administrator Tatriz', 'admin')`, [hashedAdmin]);
            console.log("✅ User Admin Default Berhasil Dibuat.");
        }

        // Tabel Pendukung Lainnya
        await db.run(`CREATE TABLE IF NOT EXISTS po_utama (id ${pk}, tenant_id INTEGER, tanggal TEXT, nama_po TEXT, customer TEXT, status TEXT, total_harga_customer REAL DEFAULT 0)`);
        await db.run(`CREATE TABLE IF NOT EXISTS po_detail (id ${pk}, po_id INTEGER, jenis_bordir TEXT, nama_desain TEXT, jumlah INTEGER, harga_cmt REAL DEFAULT 0, harga_operator REAL, harga_customer REAL)`);
        await db.run(`CREATE TABLE IF NOT EXISTS mesin (id ${pk}, tenant_id INTEGER, nama_mesin TEXT)`);
        await db.run(`CREATE TABLE IF NOT EXISTS hasil_kerja (id ${pk}, tenant_id INTEGER, operator_id INTEGER, po_id INTEGER, detail_id INTEGER, mesin_id INTEGER, tanggal TEXT, shift TEXT, jumlah_setor INTEGER)`);
        await db.run(`CREATE TABLE IF NOT EXISTS arus_kas (id ${pk}, tenant_id INTEGER, tanggal TEXT, jenis TEXT, kategori TEXT, jumlah REAL, keterangan TEXT, po_id INTEGER)`);
        
        console.log("🚀 Semua Tabel Supabase Siap!");
    } catch (err) {
        console.error("❌ Gagal Inisialisasi Database Supabase:", err);
    }
};

// Panggil fungsi inisialisasi
initDB();

// Jalankan inisialisasi
initDB();
//--------------------------------------------------------------------------------------------//

// --- 3. MIDDLEWARE PROTEKSI ---

function isAdmin(req, res, next) {
    if (req.session.userId && req.session.role === 'admin') next();
    else res.status(403).send("Akses Ditolak: Khusus Admin!");
}

function isFullFeature(req, res, next) {
    if (req.session.userId) next();
    else res.status(403).send("Sesi tidak valid.");
}

// --- 4. GLOBAL DATA MIDDLEWARE (Pindah ke bawah setelah login agar tidak mengganggu login) ---
// GLOBAL DATA MIDDLEWARE (Async Version)
app.use(async (req, res, next) => {
    res.locals.user = req.session; 
    
    // 1. Abaikan untuk halaman publik
    if (['/', '/login', '/register', '/register-tenant'].includes(req.path) || req.path.startsWith('/uploads')) {
        res.locals.config = { nama_aplikasi: "TATRIZ SYSTEM", nama_perusahaan: "Tatriz" };
        return next();
    }

    // 2. Ambil Tenant ID dari session dan pastikan dia ANGKA (Number)
    const tIdRaw = req.session.tenantId;
    if (!tIdRaw) {
        res.locals.config = { nama_aplikasi: "Tatriz System", nama_perusahaan: "Tatriz" };
        return next();
    }
    
    // PAKSA JADI ANGKA MURNI
    const tId = Number(tIdRaw);

    try {
        const bulanIni = new Date().toISOString().slice(0, 7);

        // Gunakan parameter yang sudah di-cast jadi Number
        const [configData, s, b] = await Promise.all([
            db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]),
            db.get("SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) as saldo FROM arus_kas WHERE tenant_id = $1", [tId]),
            db.get("SELECT SUM(jumlah) as terbayar FROM arus_kas WHERE kategori = 'BIAYA KONTRAKAN' AND tanggal LIKE $1 AND tenant_id = $2", [bulanIni + '%', tId])
        ]);

        const config = configData || { 
            nama_aplikasi: "Tatriz System", 
            nama_perusahaan: "Tatriz",
            target_bonus: 500000, nominal_bonus_dasar: 10000, nominal_buffer: 0, beban_tetap: 0
        };

        const saldoLaci = s?.saldo || 0;
        const terbayar = b?.terbayar || 0;
        const sisaBeban = (terbayar >= (config.beban_tetap || 0)) ? 0 : (config.beban_tetap || 0);

        res.locals.config = config;
        res.locals.uangKunci = {
            saldoLaci,
            totalUangDikunci: (config.nominal_buffer || 0) + sisaBeban,
            profitBolehAmbil: saldoLaci - ((config.nominal_buffer || 0) + sisaBeban),
            statusAman: (saldoLaci - ((config.nominal_buffer || 0) + sisaBeban)) > 0,
            bebanLunas: terbayar >= (config.beban_tetap || 0)
        };
        next();
    } catch (err) {
        console.error("Middleware Error Detail:", err);
        res.locals.config = { nama_aplikasi: "Tatriz (Koneksi Database Bermasalah)" };
        next();
    }
});

// Fungsi Middleware untuk mencegah browser menyimpan cache (penting untuk data realtime)
function noCache(req, res, next) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
}

// --- 5. ROUTES ---

app.get('/', async (req, res) => {
    try {
        // Ambil jumlah settings untuk cek apakah sistem baru
        const rowJml = await db.get("SELECT COUNT(*) as jml FROM settings");
        const isNewSystem = (rowJml && (Number(rowJml.jml) === 0));

        // Ambil config default (Tenant 1)
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = 1");

        res.render('login', { 
            config: config || { 
                logo_path: 'default.png', 
                nama_aplikasi: 'TATRIZ SYSTEM', 
                nama_perusahaan: 'Multi-Tenant System' 
            }, 
            isNew: isNewSystem 
        });
    } catch (err) {
        console.error("Error di Halaman Depan:", err);
        res.status(500).send("Gagal memuat halaman login: " + err.message);
    }
});

// --- LOGIN ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Gunakan String() untuk memastikan tipe data ke Postgres
        const user = await db.get("SELECT * FROM users WHERE username = $1", [String(username)]);
        
        if (!user) {
            return res.send("<script>alert('Username tidak ditemukan.'); window.history.back();</script>");
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.send("<script>alert('Password salah.'); window.history.back();</script>");
        }

        // Set Session
        req.session.userId = user.id;
        req.session.tenantId = user.tenant_id;
        req.session.role = user.role;
        req.session.nama = user.nama_lengkap;

        // WAJIB di Vercel: Simpan session sebelum redirect
        req.session.save((err) => {
            if (err) console.error("Session Save Error:", err);
            res.redirect('/dashboard');
        });

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).send("Terjadi kesalahan sistem saat login.");
    }
});

// HAPUS SEMUA app.post('/register-tenant') yang lama, ganti dengan ini:
app.post('/register-tenant', async (req, res) => {
    const { nama_toko, username, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        // 1. Ambil Max Tenant ID dengan pengaman COALESCE (Standar Postgres)
        const row = await db.get("SELECT COALESCE(MAX(tenant_id), 0) as maxid FROM settings");
        let currentMax = Number(row.maxid);
        let newTenantId = (currentMax < 100) ? 100 : currentMax + 1;

        // 2. Gunakan satu koneksi untuk memastikan urutan (Optional tapi lebih aman)
        await db.run(
            "INSERT INTO settings (tenant_id, nama_perusahaan, level, nama_aplikasi, logo_path) VALUES ($1, $2, 1, 'TATRIZ ONLINE', 'default.png')", 
            [parseInt(newTenantId), String(nama_toko)]
        );

        await db.run(
            "INSERT INTO users (tenant_id, username, password, role, nama_lengkap) VALUES ($1, $2, $3, 'admin', $4)", 
            [parseInt(newTenantId), String(username), hashedPassword, 'Owner ' + nama_toko]
        );

        res.send("<script>alert('Pendaftaran Berhasil! Silakan Login.'); window.location='/';</script> ");
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).send("Gagal mendaftar: " + error.message);
    }
});

// Tampilkan halaman form
app.get('/register', (req, res) => {
    res.render('register');
});

// --- KONFIGURASI MULTER (SERVERLESS READY - MEMORY ONLY) ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // maksimal 10MB (opsional, bisa ubah)
  },
});



app.post('/save-settings', isAdmin, upload.single('logo'), async (req, res) => {
    try {
        const tId = req.session.tenantId; 
        const { 
            nama_aplikasi, 
            nama_perusahaan, 
            alamat, 
            no_hp, 
            password_admin, 
            target_bonus, 
            beban_tetap, 
            nominal_buffer 
        } = req.body;

        let logoUrl = null;

        // ✅ Jika ada file logo, upload ke Supabase Storage
        if (req.file) {
            const fileExt = req.file.originalname.split('.').pop();
            const fileName = `logo-${tId}-${uuidv4()}.${fileExt}`;

            const { data, error } = await supabase.storage
                .from("uploads") // nama bucket
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: true,
                });

            if (error) {
                console.error(error);
                return res.status(500).send("Gagal upload logo.");
            }

            // Ambil public URL
            const { data: publicUrl } = supabase.storage
                .from("uploads")
                .getPublicUrl(fileName);

            logoUrl = publicUrl.publicUrl;
        }

        let sqlUpdate = `UPDATE settings SET 
            nama_aplikasi=?, 
            nama_perusahaan=?, 
            alamat=?, 
            no_hp=?, 
            password_admin=?, 
            target_bonus=?, 
            beban_tetap=?, 
            nominal_buffer=?`;

        let params = [
            nama_aplikasi, 
            nama_perusahaan, 
            alamat, 
            no_hp, 
            password_admin, 
            target_bonus, 
            beban_tetap, 
            nominal_buffer
        ];

        if (logoUrl) {
            sqlUpdate += `, logo_path=?`;
            params.push(logoUrl);
        }

        sqlUpdate += ` WHERE tenant_id=?`;
        params.push(tId);

        db.run(sqlUpdate, params, (err) => {
            if (err) return res.status(500).send("Gagal menyimpan pengaturan.");
            res.send("<script>alert('Pengaturan Berhasil Disimpan!'); window.location='/dashboard';</script>");
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Terjadi kesalahan server.");
    }
});

// --- DASHBOARD ---
app.get('/dashboard', isAdmin, async (req, res) => {
    try {
        const tId = parseInt(req.session.tenantId); 
        if (!tId) return res.redirect('/');

        const [stats, rowP, rowM] = await Promise.all([
            // Query 1: Statistik PO
            db.get("SELECT COUNT(CASE WHEN status = 'Design' THEN 1 END) as jml_design, COUNT(CASE WHEN status = 'Produksi' THEN 1 END) as jml_produksi, COUNT(CASE WHEN status = 'Clear' THEN 1 END) as jml_invoice, COUNT(CASE WHEN status = 'DP/Cicil' THEN 1 END) as jml_cicil FROM po_utama WHERE tenant_id = $1", [tId]),
            
            // Query 2: Total Piutang
            db.get("SELECT ((SELECT COALESCE(SUM(total_harga_customer), 0) FROM po_utama WHERE tenant_id = $1) - (SELECT COALESCE(SUM(jumlah), 0) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tenant_id = $1)) as total_piutang", [tId]),
            
            // Query 3: Masalah Produksi (INI YANG KITA PERBAIKI)
            db.get(`SELECT COUNT(*) as total FROM (
                SELECT h.detail_id 
                FROM hasil_kerja h 
                JOIN po_detail d ON h.detail_id = d.id 
                WHERE h.tenant_id = $1 
                GROUP BY h.detail_id, d.jumlah 
                HAVING SUM(h.jumlah_setor) > d.jumlah
            ) as sub`, [tId])
        ]);

        res.render('dashboard', {
            stats: stats || { jml_design: 0, jml_produksi: 0, jml_invoice: 0, jml_cicil: 0 },
            totalPiutangSemua: rowP?.total_piutang || 0,
            jumlahMasalah: rowM?.total || 0,
            user: req.session
        });
    } catch (err) {
        console.error("Dashboard Error Detail:", err);
        res.status(500).send("Gagal memuat dashboard. Periksa konsol.");
    }
});

// --- RUTE SETUP ---
// 1. POST SETUP AUTH (Proses Cek Password Setup)
app.post('/setup-auth', async (req, res) => {
    const { password } = req.body;
    const tId = Number(req.session.tenantId); // Paksa jadi angka untuk Postgres

    try {
        const row = await db.get("SELECT password_admin FROM settings WHERE tenant_id = $1", [tId]);
        
        // Jika di database masih NULL/kosong, gunakan default 'admin123'
        const correctPassword = row?.password_admin || 'admin123'; 

        if (String(password) === String(correctPassword)) {
            req.session.isAdminSetup = true; 
            req.session.save(() => {
                res.redirect('/setup');
            });
        } else {
            res.send("<script>alert('Password Admin Salah!'); window.location='/setup-auth';</script>");
        }
    } catch (err) {
        console.error("Setup Auth Error:", err);
        res.status(500).send("Gagal autentikasi setup.");
    }
});

// 2. GET SETUP (Halaman Pengaturan User & Mesin)
app.get('/setup', noCache, async (req, res) => {
    if (!req.session.isAdminSetup) return res.redirect('/setup-auth');
    
    // Pastikan ini benar-benar angka
    const tId = Number(req.session.tenantId) || 0;

    try {
        // Kita paksa Postgres membaca $1 sebagai INTEGER dengan ::INTEGER
        const [users, machines] = await Promise.all([
            db.all("SELECT * FROM users WHERE tenant_id = $1::INTEGER ORDER BY id ASC", [tId]),
            db.all("SELECT * FROM mesin WHERE tenant_id = $1::INTEGER ORDER BY id ASC", [tId])
        ]);

        res.render('setup', { users, machines });
    } catch (err) {
        console.error("Setup Page Error Detail:", err);
        res.status(500).send("Gagal memuat data setup: " + err.message);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// GANTI rute /save-settings lama dengan ini
app.post('/save-settings-all', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const { 
        nama_perusahaan, alamat, no_hp, nominal_buffer, 
        target_bonus, nominal_bonus_dasar, beban_tetap,
        nama_mesin_baru 
    } = req.body;

    db.serialize(() => {
        // 1. Update Tabel Settings (Gunakan IFNULL agar data lama tidak hilang jika input kosong)
        const sqlSettings = `UPDATE settings SET 
                             nama_perusahaan = ?, alamat = ?, no_hp = ?, nominal_buffer = ?,
                             target_bonus = IFNULL(?, target_bonus), 
                             nominal_bonus_dasar = IFNULL(?, nominal_bonus_dasar),
                             beban_tetap = IFNULL(?, beban_tetap)
                             WHERE tenant_id = ?`;
        
        db.run(sqlSettings, [
            nama_perusahaan, 
            alamat, 
            no_hp, 
            Number(nominal_buffer) || 0, 
            target_bonus || null, 
            nominal_bonus_dasar || null, 
            beban_tetap || null, 
            tId
        ]);

        // 2. Jika Anda (Owner/Pro) mengisi nama mesin baru, masukkan ke tabel mesin
        if (nama_mesin_baru && nama_mesin_baru.trim() !== "") {
            db.run(`INSERT INTO mesin (tenant_id, nama_mesin) VALUES (?, ?)`, [tId, nama_mesin_baru.trim()]);
        }
    });

    res.redirect('/setup');
});

// --- RUTE MANAJEMEN PESANAN (PO-DATA) ---
app.get('/po-data', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { search_po, search_customer } = req.query;

    try {
        // 1. Susun Query Utama
        let query = `
            SELECT p.*, 
            (SELECT jumlah FROM po_detail WHERE po_id = p.id LIMIT 1) as qty_tampil,
            (SELECT COUNT(DISTINCT jumlah) FROM po_detail WHERE po_id = p.id) as variasi_jumlah
            FROM po_utama p 
            WHERE p.tenant_id = ?
        `;
        let params = [tId];

        if (search_po) {
            query += " AND nama_po LIKE ?";
            params.push(`%${search_po}%`);
        }
        if (search_customer) {
            query += " AND customer LIKE ?";
            params.push(`%${search_customer}%`);
        }

        query += ` ORDER BY 
            CASE 
                WHEN status = 'Design' THEN 1
                WHEN status = 'Produksi' THEN 2
                WHEN status = 'QC' THEN 3
                WHEN status = 'Clear' THEN 4
                WHEN status = 'DP/Cicil' THEN 5
                WHEN status = 'Lunas' THEN 6
                ELSE 7
            END ASC, tanggal DESC, id DESC`;

        // 2. Jalankan Query secara paralel
        const [orders, allDetails] = await Promise.all([
            db.all(query, params),
            db.all(`SELECT d.* FROM po_detail d JOIN po_utama p ON d.po_id = p.id WHERE p.tenant_id = ?`, [tId])
        ]);

        res.render('po-data', { 
            orders: orders || [], 
            details: allDetails || [],
            user: req.session,
            filters: req.query 
        });

    } catch (err) {
        console.error("Gagal memuat PO Data:", err);
        res.status(500).send("Internal Server Error");
    }
});


app.get('/po-baru', (req, res) => {
    if (req.session.userId) {
        res.render('po-baru');
    } else {
        res.redirect('/');
    }
});

// API Sugesti Nama PO & Customer
app.get('/api/sugesti-po', (req, res) => {
    const tId = req.session.tenantId;
    db.all(`SELECT DISTINCT nama_po, customer FROM po_utama WHERE tenant_id = ?`, [tId], (err, rows) => {
        if (err) return res.json([]);
        res.json(rows);
    });
});

// API Sugesti Jenis Bordir
app.get('/api/sugesti-bordir', (req, res) => {
    const tId = req.session.tenantId;
    // Kita join ke po_utama untuk memastikan hanya mengambil data milik tenant ini
    const sql = `SELECT DISTINCT d.jenis_bordir 
                 FROM po_detail d 
                 JOIN po_utama p ON d.po_id = p.id 
                 WHERE p.tenant_id = ?`;
    db.all(sql, [tId], (err, rows) => {
        if (err) return res.json([]);
        res.json(rows);
    });
});

// --- RUTE PENDUKUNG: UPDATE STATUS PO ---
app.post('/update-status/:id', isAdmin, (req, res) => {
    const poId = req.params.id;
    const { status_baru } = req.body;
    const tId = req.session.tenantId;

    // Pastikan WHERE menyertakan tenant_id
    db.run("UPDATE po_utama SET status = ? WHERE id = ? AND tenant_id = ?", 
    [status_baru, poId, tId], (err) => {
        if (err) return res.status(500).send("Gagal update status.");
        res.redirect('/po-data'); 
    });
});

app.post('/save-kas', (req, res) => {
    const tId = req.session.tenantId;
    const { kas_id, tanggal, jenis, kategori, jumlah, keterangan, po_id } = req.body;
    const ref_po = (kategori === "PEMBAYARAN BORDIR") ? po_id : null;

    if (kas_id) {
        db.run(`UPDATE arus_kas SET tanggal=?, jenis=?, kategori=?, jumlah=?, keterangan=?, po_id=? WHERE id=? AND tenant_id=?`,
        [tanggal, jenis, kategori, jumlah, keterangan, ref_po, kas_id, tId], (err) => {
            if (ref_po) updateStatusPO(ref_po);
            res.redirect('/laporan-kas');
        });
    } else {
        db.run(`INSERT INTO arus_kas (tenant_id, tanggal, jenis, kategori, jumlah, keterangan, po_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tId, tanggal, jenis, kategori, jumlah, keterangan, ref_po], (err) => {
            if (ref_po) updateStatusPO(ref_po);
            res.redirect('/laporan-kas');
        });
    }
});

app.get('/setup-auth', isAdmin, (req, res) => {
    const tId = req.session.tenantId;

    // Ambil data Karyawan & Mesin secara paralel milik tenant ini
    const sqlUsers = "SELECT * FROM users WHERE tenant_id = ? ORDER BY role DESC";
    const sqlMachines = "SELECT * FROM mesin WHERE tenant_id = ? ORDER BY id ASC";

    db.all(sqlUsers, [tId], (err, users) => {
        db.all(sqlMachines, [tId], (err, machines) => {
            // Kita panggil res.locals.config yang sudah disiapkan oleh middleware sebelumnya
            res.render('setup-auth', { 
                users: users || [], 
                machines: machines || [] 
            });
        });
    });
});

// A. Simpan/Update User
app.post('/save-user', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const { user_id, nama_lengkap, username, password, gaji_pokok, role } = req.body;

    if (user_id) { // Mode Edit
        db.run("UPDATE users SET nama_lengkap=?, username=?, password=?, gaji_pokok=?, role=? WHERE id=? AND tenant_id=?", 
        [nama_lengkap, username, password, gaji_pokok, role, user_id, tId], () => res.redirect('/setup-auth'));
    } else { // Mode Baru
        db.run("INSERT INTO users (tenant_id, nama_lengkap, username, password, gaji_pokok, role) VALUES (?,?,?,?,?,?)", 
        [tId, nama_lengkap, username, password, gaji_pokok, role], () => res.redirect('/setup-auth'));
    }
});

// B. Simpan/Update Mesin
app.post('/save-mesin', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const { mesin_id, nama_mesin } = req.body;

    if (mesin_id) {
        db.run("UPDATE mesin SET nama_mesin=? WHERE id=? AND tenant_id=?", [nama_mesin, mesin_id, tId], () => res.redirect('/setup-auth'));
    } else {
        db.run("INSERT INTO mesin (tenant_id, nama_mesin) VALUES (?,?)", [tId, nama_mesin], () => res.redirect('/setup-auth'));
    }
});

// C. Hapus Mesin
app.get('/delete-mesin/:id', isAdmin, (req, res) => {
    db.run("DELETE FROM mesin WHERE id=? AND tenant_id=?", [req.params.id, req.session.tenantId], () => res.redirect('/setup-auth'));
});

app.post('/simpan-kerja', async (req, res) => {
    const { tanggal, shift, po_id, detail_id, jumlah_setor, mesin_id } = req.body;
    const userId = req.session.userId;
    const tId = req.session.tenantId;

    if (!jumlah_setor || Number(jumlah_setor) <= 0) {
        return res.send("<script>alert('Jumlah tidak valid!'); window.history.back();</script>");
    }

    try {
        // 1. Simpan hasil kerja
        const sqlInsert = `INSERT INTO hasil_kerja (tenant_id, operator_id, po_id, detail_id, mesin_id, tanggal, shift, jumlah_setor) 
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.run(sqlInsert, [tId, userId, po_id, detail_id, mesin_id, tanggal, shift, jumlah_setor]);

        // 2. Cek apakah PO sudah selesai (Auto-update ke QC)
        const sqlCheck = `
            SELECT 
                (SELECT SUM(jumlah) FROM po_detail WHERE po_id = ?) as target,
                (SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE po_id = ?) as realisasi
        `;
        const row = await db.get(sqlCheck, [po_id, po_id]);

        if (row && Number(row.realisasi) >= Number(row.target)) {
            await db.run("UPDATE po_utama SET status = 'QC' WHERE id = ?", [po_id]);
        }

        res.redirect('/hasil-saya');
    } catch (err) {
        console.error("Gagal simpan hasil kerja:", err);
        res.status(500).send("Gagal menyimpan data produksi.");
    }
});

// RUTE BARU: INPUT GAJI (FRESH & CLEAN)
app.get('/input-gaji', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const { tgl_awal, tgl_akhir } = req.query;

    // STEP 1: Ambil settingan toko dulu (biar header & bonus gak error)
    db.get("SELECT * FROM settings WHERE tenant_id = ?", [tId], (err, config) => {
        const activeConfig = config || { 
            nama_aplikasi: "Tatriz System", 
            target_bonus: 500000, 
            nominal_bonus_dasar: 10000, 
            kelipatan_bonus: 100000, 
            nominal_bonus_lipat: 5000 
        };

        // STEP 2: Jika admin belum pilih tanggal, munculkan form pilih tanggal
        if (!tgl_awal || !tgl_akhir) {
            return res.render('admin/pilih-tanggal-gaji', { 
                config: activeConfig, 
                user: req.session 
            });
        }

        // STEP 3: Jika tanggal sudah ada, tarik data produksi dari database
        const sql = `
            SELECT u.id, u.nama_lengkap, u.gaji_pokok, u.role, 
                   h.tanggal, h.jumlah_setor, d.harga_operator
            FROM users u
            LEFT JOIN hasil_kerja h ON u.id = h.operator_id AND h.tanggal BETWEEN ? AND ?
            LEFT JOIN po_detail d ON h.detail_id = d.id
            WHERE u.tenant_id = ? AND u.role IN ('operator', 'QC')
            ORDER BY u.nama_lengkap ASC
        `;

        db.all(sql, [tgl_awal, tgl_akhir, tId], (err, rows) => {
            if (err) return res.status(500).send("Database Error");

            const rekap = {};
            rows.forEach(row => {
                if (!rekap[row.id]) {
                    rekap[row.id] = { 
                        id: row.id, nama: row.nama_lengkap, role: row.role, 
                        gp: row.gaji_pokok || 0, borongan: 0, bonus: 0, harian: {} 
                    };
                }
                
                if (row.tanggal && row.role === 'operator') {
                    const sub = (row.jumlah_setor || 0) * (row.harga_operator || 0);
                    rekap[row.id].borongan += sub;
                    rekap[row.id].harian[row.tanggal] = (rekap[row.id].harian[row.tanggal] || 0) + sub;
                }
            });

            // STEP 4: Hitung Bonus Harian (Dinamis)
            Object.values(rekap).forEach(op => {
                Object.values(op.harian).forEach(totalHari => {
                    if (totalHari >= activeConfig.target_bonus) {
                        let kelipatan = activeConfig.kelipatan_bonus > 0 ? activeConfig.kelipatan_bonus : 1;
                        let bonusDasar = activeConfig.nominal_bonus_dasar || 0;
                        let bonusLipat = Math.floor((totalHari - activeConfig.target_bonus) / kelipatan) * (activeConfig.nominal_bonus_lipat || 0);
                        op.bonus += (bonusDasar + bonusLipat);
                    }
                });
            });

            // STEP 5: Tampilkan ke halaman tabel gaji
            res.render('admin/input-gaji', { 
                rekap, tgl_awal, tgl_akhir, 
                config: activeConfig, 
                user: req.session 
            });
        });
    });
});

app.get('/performa-operator', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);
    const targetHarian = 500000;
    
    const sqlOps = "SELECT id, nama_lengkap FROM users WHERE tenant_id = ? AND role = 'operator' ORDER BY nama_lengkap ASC";
    const sqlData = `
        SELECT h.tanggal, h.operator_id, 
               SUM(h.jumlah_setor * d.harga_operator) as upah_op,
               SUM(h.jumlah_setor * d.harga_customer) as omzet_cust
        FROM hasil_kerja h
        JOIN po_detail d ON h.detail_id = d.id
        WHERE h.tanggal LIKE ? AND h.tenant_id = ?
        GROUP BY h.tanggal, h.operator_id
    `;

    db.all(sqlOps, [tId], (err, operators) => {
        db.all(sqlData, [bulanIni + '%', tId], (err, records) => {
            const matriks = {};
            const performaOps = {};

            operators.forEach(op => {
                performaOps[op.id] = { nama: op.nama_lengkap, totalUpah: 0, kaliCapaiTarget: 0 };
            });

            records.forEach(r => {
                if (!matriks[r.tanggal]) matriks[r.tanggal] = { total_omzet_cust: 0, total_upah_op: 0 };
                matriks[r.tanggal][r.operator_id] = r.upah_op;
                matriks[r.tanggal].total_upah_op += r.upah_op;
                matriks[r.tanggal].total_omzet_cust += r.omzet_cust;

                if (performaOps[r.operator_id]) {
                    performaOps[r.operator_id].totalUpah += r.upah_op;
                    if (r.upah_op >= targetHarian) performaOps[r.operator_id].kaliCapaiTarget += 1;
                }
            });

            // HITUNG JUMLAH HARI DALAM BULAN TERSEBUT
            const tahun = parseInt(bulanIni.split('-')[0]);
            const bulan = parseInt(bulanIni.split('-')[1]);
            const jumlahHari = new Date(tahun, bulan, 0).getDate();

            res.render('admin/performa-operator', {
                bulanIni,
                operators,
                matriks: matriks,      // INI YANG TADI ERROR
                performaOps: performaOps,
                jumlahHari: jumlahHari, // INI YANG TADI ERROR
                config: res.locals.config
            });
        });
    });
});



// 2. RUTE CETAK NOTA (A6)
app.get('/cetak-nota/:id', (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;
    const sql = `SELECT p.*, (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = p.id) as total_bayar 
                 FROM po_utama p WHERE p.id = ? AND p.tenant_id = ?`;

    db.get(sql, [poId, tId], (err, po) => {
        if (!po) return res.send("Data tidak ditemukan.");
        db.all("SELECT * FROM po_detail WHERE po_id = ?", [poId], (err, details) => {
            res.render('cetak-nota', { po, details });
        });
    });
});

// 3. RUTE HAPUS PO TOTAL
app.get('/delete-po/:id', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;

    db.serialize(() => {
        // Hapus log kerja, detail, dan utama (Hanya jika milik tenant ini)
        db.run("DELETE FROM hasil_kerja WHERE po_id = ? AND tenant_id = ?", [poId, tId]);
        db.run("DELETE FROM po_detail WHERE po_id IN (SELECT id FROM po_utama WHERE id = ? AND tenant_id = ?)", [poId, tId]);
        db.run("DELETE FROM po_utama WHERE id = ? AND tenant_id = ?", [poId, tId], (err) => {
            res.redirect('/po-data');
        });
    });
});
// 1. RUTE EDIT PO (MENAMPILKAN HALAMAN)
app.get('/edit-po/:id', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;
    
    // Ambil data PO + Hitung total yang sudah dibayar dari arus_kas (tenant_id dicek di sini)
    const sqlPo = `
        SELECT p.*, 
        (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = p.id AND tenant_id = ?) as total_bayar
        FROM po_utama p 
        WHERE p.id = ? AND p.tenant_id = ?
    `;

    db.get(sqlPo, [tId, poId, tId], (err, po) => {
        if (err) return res.status(500).send("Database Error");
        if (!po) return res.status(403).send("Data tidak ditemukan atau Anda tidak memiliki akses.");
        
        // Ambil rincian desainnya
        db.all("SELECT * FROM po_detail WHERE po_id = ?", [poId], (err, details) => {
            res.render('po-edit', { 
                po: po, 
                details: details || [] 
            });
        });
    });
});

app.post('/update-po', isAdmin, async (req, res) => {
    const { id, nama_po, customer, tanggal, status, keterangan, qty, harga_customer, harga_operator } = req.body;
    const tId = req.session.tenantId;

    try {
        // 1. Update data utama
        await db.run(
            "UPDATE po_utama SET nama_po = ?, customer = ?, tanggal = ?, status = ?, keterangan = ? WHERE id = ? AND tenant_id = ?",
            [nama_po, customer, tanggal, status, keterangan, id, tId]
        );

        // 2. Bersihkan detail lama (agar tidak duplikat saat edit)
        await db.run("DELETE FROM po_detail WHERE po_id = ?", [id]);

        // 3. Masukkan detail baru secara massal (Looping Await)
        let totalHarga = 0;
        const qtys = Array.isArray(qty) ? qty : [qty];
        const h_custs = Array.isArray(harga_customer) ? harga_customer : [harga_customer];
        const h_ops = Array.isArray(harga_operator) ? harga_operator : [harga_operator];

        for (let i = 0; i < qtys.length; i++) {
            const q = Number(qtys[i]) || 0;
            const hc = Number(h_custs[i]) || 0;
            const ho = Number(h_ops[i]) || 0;
            
            totalHarga += (q * hc);

            await db.run(
                "INSERT INTO po_detail (po_id, jumlah, harga_customer, harga_operator) VALUES (?, ?, ?, ?)",
                [id, q, hc, ho]
            );
        }

        // 4. Update total harga di tabel utama
        await db.run("UPDATE po_utama SET total_harga_customer = ? WHERE id = ?", [totalHarga, id]);

        res.redirect('/po-data');
    } catch (err) {
        console.error("Gagal update PO:", err);
        res.status(500).send("Gagal memperbarui data pesanan.");
    }
});

// 2. RUTE CETAK NOTA (A6)
app.get('/cetak-nota/:id', (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;
    const sql = `SELECT p.*, (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = p.id) as total_bayar 
                 FROM po_utama p WHERE p.id = ? AND p.tenant_id = ?`;

    db.get(sql, [poId, tId], (err, po) => {
        if (!po) return res.send("Data tidak ditemukan.");
        db.all("SELECT * FROM po_detail WHERE po_id = ?", [poId], (err, details) => {
            res.render('cetak-nota', { po, details });
        });
    });
});

// --- RUTE CETAK NOTA RINCI (A6 Portrait) ---
app.get('/cetak-nota-rinci/:id', (req, res) => {
    const tId = req.session.tenantId; // Proteksi tenant
    const poId = req.params.id;

    // 1. Ambil data Header PO + Hitung total bayar dari arus_kas (filter per tenant)
    const sqlPo = `
        SELECT p.*, 
        (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = p.id AND tenant_id = ?) as total_bayar
        FROM po_utama p 
        WHERE p.id = ? AND p.tenant_id = ?
    `;

    db.get(sqlPo, [tId, poId, tId], (err, po) => {
        if (err) return res.status(500).send("Database Error");
        if (!po) return res.status(404).send("Nota tidak ditemukan atau Anda tidak memiliki akses.");

        // 2. Ambil semua detail item bordir untuk nota ini
        const sqlDetails = `SELECT * FROM po_detail WHERE po_id = ?`;
        
        db.all(sqlDetails, [poId], (err, details) => {
            if (err) return res.status(500).send("Gagal memuat detail nota.");

            // 3. Render ke halaman nota-rinci.ejs
            // config sudah otomatis terlempar dari middleware res.locals
            res.render('cetak-nota-rinci', { 
                po: po, 
                details: details || [] 
            });
        });
    });
});

// 3. RUTE HAPUS PO TOTAL
app.get('/delete-po/:id', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;

    db.serialize(() => {
        // Hapus log kerja, detail, dan utama (Hanya jika milik tenant ini)
        db.run("DELETE FROM hasil_kerja WHERE po_id = ? AND tenant_id = ?", [poId, tId]);
        db.run("DELETE FROM po_detail WHERE po_id IN (SELECT id FROM po_utama WHERE id = ? AND tenant_id = ?)", [poId, tId]);
        db.run("DELETE FROM po_utama WHERE id = ? AND tenant_id = ?", [poId, tId], (err) => {
            res.redirect('/po-data');
        });
    });
});

// 4. RUTE KE OPERATOR
app.get('/operator', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    const userId = req.session.userId;
    const tId = req.session.tenantId;
    const tglHariIni = new Date().toISOString().split('T')[0];

    // 1. Ambil PO yang sedang dalam status 'Produksi' dan milik Tenant ini
    // Kita filter agar PO yang jumlah setornya sudah memenuhi target tidak muncul lagi
    const sqlPO = `
        SELECT p.* FROM po_utama p
        JOIN po_detail d ON p.id = d.po_id
        LEFT JOIN hasil_kerja h ON d.id = h.detail_id
        WHERE p.status = 'Produksi' AND p.tenant_id = ?
        GROUP BY p.id
        HAVING SUM(d.jumlah) > COALESCE(SUM(h.jumlah_setor), 0)
    `;

    db.all(sqlPO, [tId], (err, active_pos) => {
        // 2. Ambil Daftar Mesin milik Tenant ini
        db.all("SELECT * FROM mesin WHERE tenant_id = ? ORDER BY nama_mesin ASC", [tId], (err, daftarMesin) => {
            
            // 3. Hitung Pencapaian Hari Ini untuk monitoring bonus
            // Kita ambil dari res.locals.config yang sudah disiapkan middleware tadi
            const targetBonus = res.locals.config.target_bonus || 500000;
            
            const sqlCekHasil = `
                SELECT SUM(h.jumlah_setor * d.harga_operator) as total_upah
                FROM hasil_kerja h
                JOIN po_detail d ON h.detail_id = d.id
                WHERE h.operator_id = ? AND h.tanggal = ?
            `;
            
            db.get(sqlCekHasil, [userId, tglHariIni], (err, row) => {
                const totalHariIni = row?.total_upah || 0;
                let kurangnya = targetBonus - totalHariIni;
                if (kurangnya < 0) kurangnya = 0;

                res.render('operator', { 
                    user: req.session,
                    active_pos: active_pos || [],
                    daftarMesin: daftarMesin || [],
                    kurangnya: kurangnya
                });
            });
        });
    });
});

app.get('/api/po-details/:id', (req, res) => {
    const poId = req.params.id;
    // Query ini penting agar data 'Nama Desain' dan 'Jenis' terkirim semua ke EJS
    const sql = `
        SELECT d.*, 
               (d.jumlah - COALESCE((SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE detail_id = d.id), 0)) as sisa
        FROM po_detail d
        WHERE d.po_id = ?
    `;
    db.all(sql, [poId], (err, rows) => {
        if (err) return res.json([]);
        // Filter agar desain yang sudah lunas (sisa <= 0) tidak muncul di HP operator
        const sisaAda = rows.filter(r => r.sisa > 0);
        res.json(sisaAda);
    });
});

app.post('/simpan-kerja', (req, res) => {
    // Pastikan nama variabel di sini (detail_id) sama dengan 'name' di tag <select> EJS
    const { tanggal, shift, po_id, detail_id, jumlah_setor, mesin_id } = req.body;
    const userId = req.session.userId;
    const tId = req.session.tenantId;

    if (!jumlah_setor || Number(jumlah_setor) <= 0) {
        return res.send("<script>alert('Jumlah tidak valid!'); window.history.back();</script>");
    }

    db.serialize(() => {
        const sqlInsert = `INSERT INTO hasil_kerja (tenant_id, operator_id, po_id, detail_id, mesin_id, tanggal, shift, jumlah_setor) 
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        
        db.run(sqlInsert, [tId, userId, po_id, detail_id, mesin_id, tanggal, shift, jumlah_setor], function(err) {
            if (err) return res.status(500).send("Gagal simpan data.");

            // LOGIKA AUTO-UPDATE STATUS KE QC
            // Ini penting supaya kalau PO sudah selesai dikerjakan semua, statusnya pindah otomatis
            const sqlCheck = `
                SELECT 
                    (SELECT SUM(jumlah) FROM po_detail WHERE po_id = ?) as target,
                    (SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE po_id = ?) as realisasi
            `;
            db.get(sqlCheck, [po_id, po_id], (err, row) => {
                if (row && row.realisasi >= row.target) {
                    db.run("UPDATE po_utama SET status = 'QC' WHERE id = ?", [po_id]);
                }
                res.redirect('/hasil-saya');
            });
        });
    });
});

// --- RUTE REKAP HASIL KERJA OPERATOR ---
app.get('/hasil-saya', (req, res) => {
    // Pastikan user sudah login
    if (!req.session.userId) return res.redirect('/');

    const userId = req.session.userId;
    const userName = req.session.nama;
    const tId = req.session.tenantId;

    // Query untuk mengambil riwayat kerja operator tersebut
    // Kita join dengan po_utama dan po_detail untuk mendapatkan Nama PO dan Harga Upah
    const sql = `
        SELECT h.*, p.nama_po, d.jenis_bordir, d.nama_desain, d.harga_operator 
        FROM hasil_kerja h
        JOIN po_utama p ON h.po_id = p.id
        JOIN po_detail d ON h.detail_id = d.id
        WHERE h.operator_id = ? AND h.tenant_id = ?
        ORDER BY h.tanggal DESC, h.shift ASC
    `;

    db.all(sql, [userId, tId], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Gagal memuat rekap hasil kerja.");
        }

        // Render ke halaman hasil-kerja-operator.ejs
        // Logika pengelompokan (grouping) dan bonus sudah ditangani di sisi EJS Anda
        res.render('hasil-kerja-operator', { 
            rows: rows || [], 
            userName: userName 
        });
    });
});



// --- RUTE DAFTAR LOG PRODUKSI (ADMIN) ---
app.get('/daftar-produksi', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);

    // Query super lengkap: Mengambil log kerja, nama OP, Nama PO, dan menghitung total setoran per desain
    const sql = `
        SELECT 
            h.id as ID_PROD, 
            h.tanggal as TANGGAL, 
            h.shift as SHIFT, 
            u.nama_lengkap as OP, 
            p.nama_po as NAMA_PO, 
            p.customer as PEMILIK, 
            d.nama_desain as NAMA_BORDIR, 
            d.jenis_bordir as JENIS_BORDIR, 
            d.jumlah as TARGET_PO, 
            h.jumlah_setor as JML, 
            d.harga_operator as HARGA_PABRIK, 
            (h.jumlah_setor * d.harga_operator) as TOTAL_H_PABRIK,
            (SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE detail_id = h.detail_id) as TOTAL_SDH_SETOR
        FROM hasil_kerja h
        JOIN users u ON h.operator_id = u.id
        JOIN po_utama p ON h.po_id = p.id
        JOIN po_detail d ON h.detail_id = d.id
        WHERE h.tanggal LIKE ? AND h.tenant_id = ?
        ORDER BY h.tanggal DESC, h.id DESC
    `;

    db.all(sql, [bulanIni + '%', tId], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Gagal memuat log produksi.");
        }
        
        res.render('admin/daftar-produksi', { 
            dataProduksi: rows || [], 
            bulanIni: bulanIni 
        });
    });
});

// --- PROSES UPDATE LOG PRODUKSI ---
app.post('/update-produksi', isAdmin, (req, res) => {
    const { id_prod, tanggal, shift, jumlah } = req.body;
    const tId = req.session.tenantId;

    const sql = `
        UPDATE hasil_kerja 
        SET tanggal = ?, shift = ?, jumlah_setor = ? 
        WHERE id = ? AND tenant_id = ?
    `;

    db.run(sql, [tanggal, shift, jumlah, id_prod, tId], (err) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Gagal mengupdate data produksi.");
        }
        res.redirect('/daftar-produksi');
    });
});

// --- PROSES HAPUS LOG PRODUKSI ---
app.get('/hapus-produksi/:id', isAdmin, (req, res) => {
    const idProd = req.params.id;
    const tId = req.session.tenantId;

    db.run("DELETE FROM hasil_kerja WHERE id = ? AND tenant_id = ?", [idProd, tId], (err) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Gagal menghapus data produksi.");
        }
        res.redirect('/daftar-produksi');
    });
});

// --- RUTE LAPORAN KAS & ANALISIS PROFIT ---
app.get('/laporan-kas', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);
    
    try {
        // Ambil Config & Data Statistik secara paralel
        const [conf, data, rowP, rincian, monitor] = await Promise.all([
            db.get("SELECT * FROM settings WHERE tenant_id = ?", [tId]),
            db.get(`SELECT 
                (SELECT SUM(h.jumlah_setor * d.harga_customer) FROM hasil_kerja h JOIN po_detail d ON h.detail_id = d.id WHERE h.tanggal LIKE ? AND h.tenant_id = ?) as prod_bln,
                (SELECT SUM(jumlah) FROM arus_kas WHERE jenis = 'PENGELUARAN' AND kategori NOT IN ('BIAYA KONTRAKAN', 'BAYAR HUTANG') AND tanggal LIKE ? AND tenant_id = ?) as op_bln,
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori = 'BIAYA KONTRAKAN' AND tanggal LIKE ? AND tenant_id = ?) as k_bayar_bln,
                (SELECT SUM(CASE WHEN kategori = 'HUTANG' THEN jumlah WHEN kategori = 'BAYAR HUTANG' THEN -jumlah ELSE 0 END) FROM arus_kas WHERE tenant_id = ?) as hutang_riil,
                (SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) FROM arus_kas WHERE tenant_id = ?) as saldo_laci
            `, [bulanIni + '%', tId, bulanIni + '%', tId, bulanIni + '%', tId, tId, tId]),
            db.get(`SELECT (
                (SELECT SUM(h2.jumlah_setor * d2.harga_customer) FROM hasil_kerja h2 JOIN po_detail d2 ON h2.detail_id = d2.id WHERE h2.tenant_id = ?) - 
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tenant_id = ?)
            ) as piutang_total`, [tId, tId]),
            db.all(`SELECT ak.*, p.customer, p.nama_po FROM arus_kas ak LEFT JOIN po_utama p ON ak.po_id = p.id WHERE ak.tanggal LIKE ? AND ak.tenant_id = ? ORDER BY ak.tanggal DESC, ak.id DESC`, [bulanIni + '%', tId]),
            db.all(`SELECT h.tanggal, SUM(h.jumlah_setor * d.harga_customer) as total_harian FROM hasil_kerja h JOIN po_detail d ON h.detail_id = d.id WHERE h.tanggal LIKE ? AND h.tenant_id = ? GROUP BY h.tanggal ORDER BY h.tanggal DESC`, [bulanIni + '%', tId])
        ]);

        const activeConfig = conf || { beban_tetap: 0, nominal_buffer: 0 };
        const prod = data?.prod_bln || 0;
        const op = data?.op_bln || 0;
        const k_terbayar = data?.k_bayar_bln || 0;
        const sisaBebanKontrakan = Math.max(0, (activeConfig.beban_tetap || 0) - k_terbayar);

        res.render('laporan-kas', {
            bulanIni,
            nilaiProduksi: prod,
            totalBiaya: op,
            sisaHutangRiil: data?.hutang_riil || 0,
            sisaBebanKontrakan,
            estimasiProfit: prod - op - (activeConfig.beban_tetap || 0),
            saldoRiil: data?.saldo_laci || 0,
            piutangBerjalan: rowP?.piutang_total || 0,
            monitorHarian: monitor || [],
            rincianKas: rincian || [],
            config: activeConfig
        });

    } catch (err) {
        console.error("Laporan Kas Error:", err);
        res.status(500).send("Gagal memuat laporan keuangan.");
    }
});

app.get('/input-kas', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    const tId = req.session.tenantId;

    // Ambil daftar PO yang statusnya bukan Lunas/Design milik tenant ini
    const sqlPO = `SELECT id, nama_po, customer, total_harga_customer 
                   FROM po_utama 
                   WHERE status NOT IN ('Lunas', 'Design') AND tenant_id = ?`;
    
    db.all(sqlPO, [tId], (err, pos) => {
        res.render('input-kas', { pos: pos || [] });
    });
});

app.post('/save-kas', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    const tId = req.session.tenantId;
    const { kas_id, tanggal, jenis, kategori, jumlah, keterangan, po_id } = req.body;
    
    // Jika kategori bukan PEMBAYARAN BORDIR, maka po_id kita set null
    const ref_po = (kategori === "PEMBAYARAN BORDIR") ? po_id : null;

    if (kas_id) {
        // --- LOGIKA UPDATE ---
        const sqlUpdate = `UPDATE arus_kas SET tanggal=?, jenis=?, kategori=?, jumlah=?, keterangan=?, po_id=? 
                           WHERE id=? AND tenant_id=?`;
        db.run(sqlUpdate, [tanggal, jenis, kategori, jumlah, keterangan, ref_po, kas_id, tId], function(err) {
            if (err) return res.status(500).send("Gagal update kas.");
            if (ref_po) updateStatusPO(ref_po);
            res.redirect('/laporan-kas');
        });
    } else {
        // --- LOGIKA INSERT BARU ---
        const sqlInsert = `INSERT INTO arus_kas (tenant_id, tanggal, jenis, kategori, jumlah, keterangan, po_id) 
                           VALUES (?, ?, ?, ?, ?, ?, ?)`;
        db.run(sqlInsert, [tId, tanggal, jenis, kategori, jumlah, keterangan, ref_po], function(err) {
            if (err) return res.status(500).send("Gagal simpan kas.");
            if (ref_po) updateStatusPO(ref_po);
            res.redirect('/laporan-kas');
        });
    }
});

// --- RUTE HAPUS TRANSAKSI KAS ---
app.get('/hapus-kas/:id', isAdmin, (req, res) => {
    const tId = req.session.tenantId; // Proteksi agar tidak bisa hapus punya tenant lain
    const kasId = req.params.id;

    // 1. Ambil po_id dulu sebelum dihapus untuk update status nantinya
    db.get("SELECT po_id FROM arus_kas WHERE id = ? AND tenant_id = ?", [kasId, tId], (err, row) => {
        const poIdTerikat = row ? row.po_id : null;

        // 2. Jalankan perintah hapus
        db.run("DELETE FROM arus_kas WHERE id = ? AND tenant_id = ?", [kasId, tId], (err) => {
            if (err) {
                console.error("Gagal hapus kas:", err.message);
                return res.status(500).send("Gagal menghapus data kas.");
            }

            // 3. Jika transaksi yang dihapus terikat ke PO (Pembayaran Bordir), 
            //    maka kita harus hitung ulang status PO tersebut (mungkin jadi belum lunas lagi)
            if (poIdTerikat) {
                updateStatusPO(poIdTerikat);
            }

            console.log(`🗑️ Kas ID #${kasId} berhasil dihapus oleh Tenant ${tId}`);
            res.redirect('/laporan-kas');
        });
    });
});

app.get('/piutang-customer', isAdmin, (req, res) => {
    const tId = req.session.tenantId;

    const sql = `
        SELECT 
            p.customer, 
            COUNT(p.id) as total_po_aktif, 
            SUM(p.total_harga_customer) as total_nilai_po,
            SUM(COALESCE(bayar.total, 0)) as total_telah_dibayar,
            SUM(p.total_harga_customer - COALESCE(bayar.total, 0)) as sisa_piutang_customer
        FROM po_utama p
        LEFT JOIN (
            SELECT po_id, SUM(jumlah) as total 
            FROM arus_kas 
            WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') 
            GROUP BY po_id
        ) bayar ON p.id = bayar.po_id
        WHERE p.status NOT IN ('Lunas', 'Design') AND p.tenant_id = ?
        GROUP BY p.customer 
        HAVING sisa_piutang_customer > 0
        ORDER BY sisa_piutang_customer DESC`;

    db.all(sql, [tId], (err, rows) => {
        if (err) return res.status(500).send("Error memuat piutang.");
        res.render('piutang-customer', { daftar: rows || [] });
    });
});

app.get('/api/piutang-detail/:customer', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const customerName = req.params.customer;

    const sql = `
        SELECT 
            p.id, p.nama_po, p.tanggal, p.total_harga_customer,
            COALESCE(SUM(ak.jumlah), 0) as telah_bayar
        FROM po_utama p
        LEFT JOIN arus_kas ak ON p.id = ak.po_id 
             AND ak.kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN')
        WHERE p.customer = ? AND p.tenant_id = ? AND p.status != 'Lunas'
        GROUP BY p.id
        HAVING (p.total_harga_customer - telah_bayar) > 0
    `;

    db.all(sql, [customerName, tId], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// --- RUTE NOTA MANUAL (HANYA HALAMAN) ---
app.get('/nota-manual', isAdmin, (req, res) => {
    // Kita tidak perlu ambil data dari DB karena form diisi manual,
    // tapi res.locals.config (logo & nama toko) akan otomatis terkirim
    res.render('nota-manual');
});

app.get('/cetak-nota-gabungan', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    let ids = req.query.ids; // Menangkap array ID dari checkbox modal
    
    if (!ids) return res.send("Tidak ada PO yang dipilih.");
    if (!Array.isArray(ids)) ids = [ids];

    // Query Header PO-PO yang dipilih
    const sqlOrders = `
        SELECT p.*, COALESCE(bayar.total, 0) as total_bayar 
        FROM po_utama p
        LEFT JOIN (
            SELECT po_id, SUM(jumlah) as total FROM arus_kas GROUP BY po_id
        ) bayar ON p.id = bayar.po_id
        WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.tenant_id = ?
    `;

    db.all(sqlOrders, [...ids, tId], (err, orders) => {
        // Ambil rincian detail untuk semua PO tersebut
        const sqlDetails = `SELECT * FROM po_detail WHERE po_id IN (${ids.map(() => '?').join(',')})`;
        
        db.all(sqlDetails, ids, (err, details) => {
            res.render('print-nota-gabungan', { orders, details });
        });
    });
});

// --- RUTE MONITORING DATA CMT ---
app.get('/admin/data-cmt', isAdmin, (req, res) => {
    const tId = req.session.tenantId;

    // 1. Query Utama: Mengambil PO berstatus CMT milik tenant
    // Kita hitung laba bersih langsung di level SQL agar performa cepat
    const sqlOrders = `
        SELECT p.*, 
        SUM(d.jumlah * (d.harga_customer - d.harga_cmt)) as total_untung
        FROM po_utama p
        JOIN po_detail d ON p.id = d.po_id
        WHERE p.status = 'CMT' AND p.tenant_id = ?
        GROUP BY p.id
        ORDER BY p.tanggal DESC
    `;

    db.all(sqlOrders, [tId], (err, orders) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Gagal memuat data CMT.");
        }

        // 2. Query Detail: Untuk mengisi laci (rincian item per baris)
        const sqlDetails = `
            SELECT d.* FROM po_detail d
            JOIN po_utama p ON d.po_id = p.id
            WHERE p.status = 'CMT' AND p.tenant_id = ?
        `;

        db.all(sqlDetails, [tId], (err, allDetails) => {
            if (err) return res.status(500).send("Gagal memuat rincian CMT.");

            res.render('admin/data-cmt', { 
                orders: orders || [], 
                details: allDetails || [] 
            });
        });
    });
});

// --- RUTE CEK AUDIT BALANCE (TENANT AWARE) ---
app.get('/cek-balance', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);

    db.get("SELECT * FROM settings WHERE tenant_id = ?", [tId], (err, config) => {
        const conf = config || { beban_tetap: 0 };

        // Kita pecah query menjadi bagian-bagian kecil agar lebih stabil
        const sqlAudit = `
            SELECT 
                -- ASET RIIL
                (SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) FROM arus_kas WHERE tenant_id = ?) as s_laci,
                (SELECT SUM(h.jumlah_setor * d.harga_customer) FROM hasil_kerja h JOIN po_detail d ON h.detail_id = d.id WHERE h.tanggal LIKE ? AND h.tenant_id = ?) as p_prod,
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tanggal LIKE ? AND tenant_id = ?) as p_kas,
                (SELECT SUM(CASE WHEN kategori = 'PIUTANG' THEN jumlah WHEN kategori = 'SARUTANGAN' THEN -jumlah ELSE 0 END) FROM arus_kas WHERE tenant_id = ?) as k_kry,
                -- KEWAJIBAN
                (SELECT SUM(CASE WHEN kategori = 'HUTANG' THEN jumlah WHEN kategori = 'BAYAR HUTANG' THEN -jumlah ELSE 0 END) FROM arus_kas WHERE tenant_id = ?) as s_hutang,
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori = 'BIAYA KONTRAKAN' AND tanggal LIKE ? AND tenant_id = ?) as k_bayar,
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori = 'JATAH PROFIT OWNER' AND tanggal LIKE ? AND tenant_id = ?) as j_owner
        `;

        const params = [
            tId,                // s_laci
            bulanIni + '%', tId, // p_prod
            bulanIni + '%', tId, // p_kas
            tId,                // k_kry
            tId,                // s_hutang
            bulanIni + '%', tId, // k_bayar
            bulanIni + '%', tId  // j_owner
        ];

        db.get(sqlAudit, params, (err, row) => {
            if (err) {
                console.error("❌ Audit Error:", err.message);
                return res.status(500).send("Gagal menghitung audit balance. Cek terminal server.");
            }

            const saldoLaci = row?.s_laci || 0;
            const piutangBulanIni = (row?.p_prod || 0) - (row?.p_kas || 0);
            const kasbonKaryawan = row?.k_kry || 0;
            const sisaHutang = row?.s_hutang || 0;
            const jatahOwner = row?.j_owner || 0;
            const kontrakanTerbayar = row?.k_bayar || 0;

            const totalUangAda = saldoLaci + piutangBulanIni + kasbonKaryawan;
            const sisaKontrakan = (conf.beban_tetap - kontrakanTerbayar) < 0 ? 0 : (conf.beban_tetap - kontrakanTerbayar);
            const profitBersih = totalUangAda - sisaHutang - sisaKontrakan - jatahOwner;

            const auditData = {
                saldoLaci,
                piutangProduksi: piutangBulanIni,
                kasbonKaryawan,
                totalUangAda,
                sisaHutang,
                kontrakan: sisaKontrakan,
                kontrakan_terbayar: kontrakanTerbayar,
                jatahSudahDiambil: jatahOwner,
                sisaProfitBersih: profitBersih
            };

            // PASTIKAN ALAMAT VIEW BENAR (Hapus 'admin/' jika file ada di root folder views)
            res.render('cek-balance', { 
                data: auditData, 
                bulanIni: bulanIni 
            });
        });
    });
});

// --- RUTE MONITOR & KOREKSI PRODUKSI (TENANT AWARE) ---
app.get('/laporan-produksi', isAdmin, (req, res) => {
    const tId = req.session.tenantId;

    // 1. Query Ringkasan Progres per Desain
    const sqlRingkasan = `
        SELECT 
            d.id as detail_id, p.nama_po, d.nama_desain, d.jenis_bordir, d.jumlah as target_po,
            SUM(COALESCE(h.jumlah_setor, 0)) as total_produksi
        FROM po_detail d
        JOIN po_utama p ON d.po_id = p.id
        LEFT JOIN hasil_kerja h ON d.id = h.detail_id
        WHERE p.tenant_id = ? AND p.status NOT IN ('Lunas', 'Clear')
        GROUP BY d.id
        ORDER BY p.tanggal DESC, p.id DESC
    `;

    // 2. Query Detail Log untuk fitur Koreksi/Pindah Desain
    const sqlLogs = `
        SELECT h.*, u.nama_lengkap 
        FROM hasil_kerja h
        JOIN users u ON h.operator_id = u.id
        WHERE h.tenant_id = ?
        ORDER BY h.tanggal DESC
    `;

    db.all(sqlRingkasan, [tId], (err, ringkasan) => {
        if (err) return res.status(500).send("Gagal memuat ringkasan produksi.");
        
        db.all(sqlLogs, [tId], (err, detailLog) => {
            // Render ke laporan-produksi.ejs (Hapus 'admin/' jika file ada di root views)
            res.render('admin/laporan-produksi', { 
                ringkasan: ringkasan || [], 
                detailLog: detailLog || [] 
            });
        });
    });
});

app.post('/admin/update-produksi', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const { log_id, tanggal_baru, shift_baru, detail_id_baru, jumlah_baru } = req.body;

    const sql = `
        UPDATE hasil_kerja 
        SET tanggal = ?, shift = ?, detail_id = ?, jumlah_setor = ? 
        WHERE id = ? AND tenant_id = ?
    `;

    db.run(sql, [tanggal_baru, shift_baru, detail_id_baru, jumlah_baru, log_id, tId], (err) => {
        if (err) {
            console.error("Gagal koreksi produksi:", err.message);
            return res.status(500).send("Gagal menyimpan koreksi.");
        }
        res.redirect('admin/laporan-produksi');
    });
});

app.get('/admin/hapus-produksi/:id', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const logId = req.params.id;

    db.run("DELETE FROM hasil_kerja WHERE id = ? AND tenant_id = ?", [logId, tId], (err) => {
        res.redirect('admin/laporan-produksi');
    });
});

// --- RUTE MANAJEMEN KARYAWAN ---
app.get('/karyawan', isAdmin, (req, res) => {
    const tId = req.session.tenantId;

    // Ambil semua user kecuali superadmin global jika ada
    const sql = "SELECT * FROM users WHERE tenant_id = ? ORDER BY role DESC, nama_lengkap ASC";
    
    db.all(sql, [tId], (err, users) => {
        if (err) return res.status(500).send("Gagal mengambil data karyawan.");
        
        // Pastikan render sesuai lokasi file (jika di folder root views)
        res.render('karyawan', { users: users || [] });
    });
});

app.post('/tambah-karyawan', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { nama_lengkap, username, password, gaji_pokok, role } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `INSERT INTO users 
                     (tenant_id, nama_lengkap, username, password, gaji_pokok, role) 
                     VALUES (?, ?, ?, ?, ?, ?)`;

        db.run(sql, [tId, nama_lengkap, username, hashedPassword, gaji_pokok, role], (err) => {
            if (err) {
                console.error(err.message);
                return res.status(500).send("Gagal menambah karyawan.");
            }
            res.redirect('/karyawan');
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error hashing password.");
    }
});

app.get('/hapus-karyawan/:id', isAdmin, (req, res) => {
    const tId = req.session.tenantId;
    const userId = req.params.id;

    // Pastikan tidak menghapus diri sendiri atau akun admin utama tenant
    db.run("DELETE FROM users WHERE id = ? AND tenant_id = ? AND username != 'admin'", [userId, tId], (err) => {
        if (err) return res.status(500).send("Gagal menghapus karyawan.");
        res.redirect('/karyawan');
    });
});


// --- RUTE BACKUP DATABASE ---
app.get('/backup-database', isAdmin, (req, res) => {
    // Sesuaikan dengan lokasi database Anda di folder ./database/tatriz.db
    const dbPath = path.join(__dirname, 'database', 'tatriz.db'); 
    
    const tgl = new Date().toISOString().slice(0, 10);
    const fileName = `Backup_Tatriz_${tgl}.db`;

    if (fs.existsSync(dbPath)) {
        res.download(dbPath, fileName, (err) => {
            if (err) {
                console.error("Gagal mendownload backup:", err);
                if (!res.headersSent) {
                    res.status(500).send("Gagal mengunduh file backup.");
                }
            }
        });
    } else {
        console.log("Path database tidak ditemukan di:", dbPath);
        res.status(404).send("File database tidak ditemukan.");
    }
});

// --- FITUR KHUSUS DEVELOPER (DEN BAGUS) ---
app.get('/master-users', isAdmin, (req, res) => {
    // Proteksi: Hanya Tenant 1 (Pusat) yang bisa akses halaman ini
    if (req.session.tenantId !== 1) {
        return res.status(403).send("Akses Ditolak: Ini adalah fitur khusus Developer!");
    }

    const sql = `
        SELECT u.id, u.username, u.nama_lengkap, u.role, u.tenant_id, 
           s.nama_perusahaan, s.level 
        FROM users u 
        LEFT JOIN settings s ON u.tenant_id = s.tenant_id 
        ORDER BY u.tenant_id ASC
    `;

    db.all(sql, [], (err, rows) => {
        res.render('admin/master-users', { users: rows || [] });
    });
});

// --- PROSES HAPUS USER GLOBAL ---
app.get('/delete-user-global/:id', isAdmin, (req, res) => {
    const userId = req.params.id;

    // Proteksi tambahan agar tidak menghapus akun Anda sendiri secara tidak sengaja
    if (userId == req.session.userId) {
        return res.send("<script>alert('Bahaya! Anda tidak bisa menghapus akun Anda sendiri.'); window.history.back();</script>");
    }

    if (req.session.tenantId === 1) {
        db.run("DELETE FROM users WHERE id = ?", [userId], (err) => {
            if (err) return res.send("Gagal menghapus user.");
            res.redirect('/master-users');
        });
    } else {
        res.status(403).send("Hanya Developer yang punya hak hapus global.");
    }
});

// --- FITUR KHUSUS DEVELOPER: HAPUS TOTAL DATA TENANT ---
app.get('/delete-tenant-complete/:tId', isAdmin, (req, res) => {
    const targetTenantId = req.params.tId;

    // Proteksi: Hanya Anda (Tenant 1) yang bisa mengeksekusi ini
    if (req.session.tenantId !== 1) {
        return res.status(403).send("Akses Ditolak!");
    }

    // Proteksi: Jangan hapus data diri sendiri (Pusat)
    if (targetTenantId == 1) {
        return res.send("<script>alert('Bahaya! Anda tidak bisa menghapus data Pusat (Tenant 1).'); window.history.back();</script>");
    }

    db.serialize(() => {
        // Hapus dari semua tabel yang memiliki tenant_id
        db.run("DELETE FROM hasil_kerja WHERE tenant_id = ?", [targetTenantId]);
        db.run("DELETE FROM arus_kas WHERE tenant_id = ?", [targetTenantId]);
        db.run("DELETE FROM mesin WHERE tenant_id = ?", [targetTenantId]);
        db.run("DELETE FROM po_detail WHERE po_id IN (SELECT id FROM po_utama WHERE tenant_id = ?)", [targetTenantId]);
        db.run("DELETE FROM po_utama WHERE tenant_id = ?", [targetTenantId]);
        db.run("DELETE FROM users WHERE tenant_id = ?", [targetTenantId]);
        db.run("DELETE FROM settings WHERE tenant_id = ?", [targetTenantId], (err) => {
            if (err) {
                console.error(err.message);
                return res.send("Gagal membersihkan data tenant.");
            }
            console.log(`🗑️ Data Tenant #${targetTenantId} telah dihapus total oleh Developer.`);
            res.redirect('/master-users');
        });
    });
});

// --- FITUR KHUSUS DEVELOPER: UPDATE LEVEL TENANT ---
app.get('/update-level/:tId/:newLevel', isAdmin, (req, res) => {
    const targetTenantId = req.params.tId;
    const newLevel = req.params.newLevel;

    // Proteksi: Hanya Anda (Tenant 1) yang bisa akses
    if (req.session.tenantId !== 1) {
        return res.status(403).send("Akses Ditolak!");
    }

    db.run("UPDATE settings SET level = ? WHERE tenant_id = ?", [newLevel, targetTenantId], (err) => {
        if (err) {
            console.error(err.message);
            return res.send("Gagal memperbarui level.");
        }
        res.redirect('/master-users');
    });
});

// --- FITUR SAKTI DEVELOPER: RESET PASSWORD SIAPAPUN ---
app.post('/developer/reset-pass', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { user_id, password_baru } = req.body;

    if (tId !== 1) {
        return res.status(403).send("Hanya Developer!");
    }

    try {
        const hashedPassword = await bcrypt.hash(password_baru, 10);

        db.run("UPDATE users SET password = ? WHERE id = ?", 
            [hashedPassword, user_id], 
            (err) => {
                if (err) return res.send("Gagal reset password.");
                res.redirect('/master-users');
            }
        );

    } catch (error) {
        res.status(500).send("Gagal hashing password.");
    }
});

// --- FUNGSI OTOMATIS UPDATE STATUS PO BERDASARKAN PEMBAYARAN ---
async function updateStatusPO(poId) {
    try {
        const sqlCek = `
            SELECT 
                (SELECT total_harga_customer FROM po_utama WHERE id = ?) as total_tagihan,
                (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = ?) as total_masuk
        `;
        const row = await db.get(sqlCek, [poId, poId]);

        if (row && Number(row.total_tagihan) > 0) {
            let statusBaru = (Number(row.total_masuk) >= Number(row.total_tagihan)) ? 'Lunas' : 'DP/Cicil';
            await db.run("UPDATE po_utama SET status = ? WHERE id = ?", [statusBaru, poId]);
            console.log(`✅ Status PO #${poId} auto-update: ${statusBaru}`);
        }
    } catch (err) {
        console.error("Gagal auto-update status PO:", err);
    }
}

app.post('/proses-print-gaji', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { tgl_awal, tgl_akhir, operator_ids, nama, gp, hari_kerja, lembur, bonus, kasbon } = req.body;

    try {
        // 1. Ambil Config secara Async
        const configRow = await db.get("SELECT * FROM settings WHERE tenant_id = ?", [tId]);
        const config = configRow || { nama_perusahaan: "Tatriz" };

        // 2. Pastikan input menjadi array (antisipasi jika hanya 1 operator)
        const ids = Array.isArray(operator_ids) ? operator_ids : [operator_ids];
        const nmList = Array.isArray(nama) ? nama : [nama];
        const gpList = Array.isArray(gp) ? gp : [gp];
        const hkList = Array.isArray(hari_kerja) ? hari_kerja : [hari_kerja];
        const lbList = Array.isArray(lembur) ? lembur : [lembur];
        const bnList = Array.isArray(bonus) ? bonus : [bonus];
        const kbList = Array.isArray(kasbon) ? kasbon : [kasbon];

        let dataGaji = [];

        // 3. Loop Perhitungan (Sekarang jauh lebih aman karena data config sudah pasti ada)
        for (let i = 0; i < ids.length; i++) {
            if (!ids[i]) continue; // Skip jika ID kosong

            let gajiPokok = Number(gpList[i]) || 0;
            let inputHK = String(hkList[i] || "0");
            let jamLembur = Number(lbList[i]) || 0;
            let totalBoronganBonus = Number(bnList[i]) || 0;
            let totalKasbon = Number(kbList[i]) || 0;

            // Logika Pemisah Hari dan Jam (Contoh: 5.6)
            let bagian = inputHK.split('.'); 
            let hariFull = Number(bagian[0]) || 0;
            let jamSisa = Number(bagian[1]) || 0;

            let nominalHari = hariFull * gajiPokok;
            let nominalJamSisa = (gajiPokok / 8) * jamSisa;
            let nominalLembur = (gajiPokok / 4) * jamLembur;
            
            let totalFinal = nominalHari + nominalJamSisa + nominalLembur + totalBoronganBonus - totalKasbon;

            dataGaji.push({
                nama: nmList[i],
                gp: gajiPokok,
                hari_kerja: hariFull,
                jam_sisa: jamSisa,
                lembur: jamLembur,
                borongan_bonus: totalBoronganBonus,
                kasbon: totalKasbon,
                totalFinal: totalFinal
            });
        }

        // 4. Render ke halaman cetak
        res.render('admin/cetak-slip', { 
            dataGaji, 
            tgl_awal, 
            tgl_akhir,
            config: config,
            user: req.session 
        });

    } catch (err) {
        console.error("Gagal memproses print gaji:", err);
        res.status(500).send("Terjadi kesalahan saat menyiapkan data cetak.");
    }
});


// JALANKAN SERVER
app.listen(port, () => console.log(`🚀 Aplikasi Tatriz berjalan di http://localhost:${port}`));
module.exports = app;