const express = require("express")
const app = express()
const fs = require("fs");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const cors = require("cors");
const users = require("./users");
const lotto = require("./lotto");
const winners = require("./winners");


app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

const SECRET_KEY = "MY_SECRET_KEY";
const USERS_FILE = "./users.json";
const LOTTO_FILE = "./lotto.json";
const WINNERS_FILE = "./winners.json";

// Helper: โหลด/บันทึกไฟล์ JSON
function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Middleware ตรวจสอบ token
function auth(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = decoded;
    next();
  });
}
function isOwner(req, res, next) {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Owner only" });
  }
  next();
}

// สมัครสมาชิก
app.post("/register", (req, res) => {
  const users = load(USERS_FILE);
  const { name, login_tel, password, wallet } = req.body;
  if (users.find((u) => u.login_tel === login_tel)) {
    return res.status(400).json({ error: "User already exists" });
  }
  const newUser = {
    id: users.length + 1,
    name,
    login_tel,
    password,
    role: "member",
    wallet
  };
  users.push(newUser);
  save(USERS_FILE, users);
  res.json({ message: "Registered", user: newUser });
});

// Login
app.post("/login", (req, res) => {
  const users = load(USERS_FILE);
  const { login_tel, password } = req.body;
  const user = users.find((u) => u.login_tel === login_tel && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, SECRET_KEY, { expiresIn: "2h" });
  res.json({ token, user });
});

// ดู wallet
app.get("/wallet", auth, (req, res) => {
  const users = load(USERS_FILE);
  const user = users.find((u) => u.id === req.user.id);
  res.json({ wallet: user.wallet });
});

// สร้างเลขล็อตโต้ (เจ้าของเท่านั้น)
app.post("/lotto/generate", auth, isOwner, (req, res) => {
  let lotto = [];
  for (let i = 0; i < 100; i++) {
    lotto.push({
      number: String(Math.floor(100000 + Math.random() * 900000)),
      price: 80,
      isSold: false,
      buyerId: null,
      claimed: false,
    });
  }
  save(LOTTO_FILE, lotto);
  res.json({ message: "Lotto generated", total: lotto.length });
});

// บันทึกเลขล็อตโต้หลายตัว (เช่น 300 ตัว)
app.post("/lotto/saveMany", (req, res) => {
  const lotto = [];
  const { numbers } = req.body;

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Missing numbers array" });
  }

  numbers.forEach(num => {
    lotto.push({
      number: String(num).padStart(6, "0"), // ✅ ครบ 6 หลัก
      price: 80,
      isSold: false,
      buyerId: null,
      claimed: false,
    });
  });

  save(LOTTO_FILE, lotto);
  res.json({ message: `Saved ${numbers.length} lotto numbers` });
});

// ดูเลขล็อตโต้ที่ยังไม่ขาย
app.get("/lotto", auth, (req, res) => {
  const lotto = load(LOTTO_FILE);
  res.json(lotto.filter((l) => !l.isSold));
});

// ซื้อเลขล็อตโต้
app.post("/lotto/buy", auth, (req, res) => {
  const { number } = req.body;
  const users = load(USERS_FILE);
  const lotto = load(LOTTO_FILE);

  const user = users.find((u) => u.id === req.user.id);
  const ticket = lotto.find((l) => l.number === number && !l.isSold);
  if (!ticket) return res.status(400).json({ error: "Ticket not available" });
  if (user.wallet < ticket.price) return res.status(400).json({ error: "Not enough balance" });

  user.wallet -= ticket.price;
  ticket.isSold = true;
  ticket.buyerId = user.id;

  save(USERS_FILE, users);
  save(LOTTO_FILE, lotto);
  res.json({ message: "Ticket purchased", wallet: user.wallet });
});

// ออกรางวัล (owner เท่านั้น)
app.post("/lotto/draw", auth, isOwner, (req, res) => {
  const lotto = load(LOTTO_FILE);
  const winners = [];
  const prizeMap = {
    1: 6000000,
    2: 200000,
    3: 80000,
    4: 4000,
    5: 2000,
  };
  const drawn = [];
  for (let i = 1; i <= 5; i++) {
    const rand = lotto[Math.floor(Math.random() * lotto.length)];
    drawn.push(rand.number);
    winners.push({ prize: i, number: rand.number, reward: prizeMap[i] });
  }
  save(WINNERS_FILE, winners);
  res.json({ message: "Draw complete", winners });
});

// ตรวจผล
app.get("/lotto/check", auth, (req, res) => {
  const lotto = load(LOTTO_FILE);
  const winners = load(WINNERS_FILE);
  const userTickets = lotto.filter((l) => l.buyerId === req.user.id);
  const results = userTickets.map((t) => {
    const win = winners.find((w) => w.number === t.number);
    return { number: t.number, prize: win?.prize || null, reward: win?.reward || 0, claimed: t.claimed };
  });
  res.json(results);
});

// ขึ้นเงิน
app.post("/lotto/claim", auth, (req, res) => {
  const { number } = req.body;
  const users = load(USERS_FILE);
  const lotto = load(LOTTO_FILE);
  const winners = load(WINNERS_FILE);

  const user = users.find((u) => u.id === req.user.id);
  const ticket = lotto.find((l) => l.number === number && l.buyerId === user.id);
  if (!ticket) return res.status(400).json({ error: "Ticket not found" });
  if (ticket.claimed) return res.status(400).json({ error: "Already claimed" });

  const win = winners.find((w) => w.number === number);
  if (!win) return res.status(400).json({ error: "Not a winning ticket" });

  user.wallet += win.reward;
  ticket.claimed = true;

  save(USERS_FILE, users);
  save(LOTTO_FILE, lotto);
  res.json({ message: "Prize claimed", wallet: user.wallet });
});

// รีเซ็ตระบบ
app.post("/reset", auth, isOwner, (req, res) => {
  // 1. ล้าง USERS เหลือแค่ owner
  save(USERS_FILE, [
    {
      id: 1,
      name: "owner",
      login_tel: "1111",
      password: "123456",
      role: "owner",
      wallet: 0,
    },
  ]);

  // 2. ล้างล็อตเตอรี่ทั้งหมด
  save(LOTTO_FILE, []);

  // 3. ล้างข้อมูลผู้ถูกรางวัล
  save(WINNERS_FILE, []);

  // 4. ส่ง response
  res.json({ message: "รีข้อมูลทั้งหมด" });
});

// ดึงข้อมูล user ตาม id
app.get('/users/:id', auth, (req, res) => {
  const users = load(USERS_FILE);
  const id = parseInt(req.params.id);
  const user = users.find(u => u.id === id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json(user);
});

app.post("/reset-password", (req, res) => {
  const { loginTel, newPassword } = req.body;

  const users = load(USERS_FILE);
  const index = users.findIndex((u) => u.login_tel === loginTel);

  if (index === -1) {
    return res.status(404).json({ success: false, message: "ไม่พบผู้ใช้" });
  }

  users[index].password = newPassword;
  save(USERS_FILE, users);

  res.json({ success: true, message: "เปลี่ยนรหัสผ่านสำเร็จ" });
});
//รีเซ็ตข้อมูลลอตเตอรี่
app.post("/reset-lotto", auth, isOwner, (req, res) => {
  save(LOTTO_FILE, []);
  res.json({ message: "ล้างข้อมูลล็อตเตอรี่ทั้งหมด" });
});

//โชว์ข้อมูลทัลอดเตอรี
app.get('/lotto', auth, isOwner, (req, res) => {
  const lotto = load(LOTTO_FILE);
  res.json(lotto);
});
//randomเลขล็อตเตอรี่ในระบบ
app.get('/lotto/randomAll', auth, isOwner, (req, res) => {
  const lotto = load(LOTTO_FILE);
  if (lotto.length === 0) {
    return res.status(400).json({ error: "No lotto numbers available" });
  }
  const randomIndex = Math.floor(Math.random() * lotto.length);
  const randomLotto = lotto[randomIndex];
  res.json(randomLotto);
});
//randomเลขล็อตเตอรี่ที่ยขายแล้ว
app.get('/lotto/randomSell', auth, isOwner, (req, res) => {
  const lotto = load(LOTTO_FILE).filter(l => l.isSold);
  if (lotto.length === 0) {
    return res.status(400).json({ error: "ยังไม่มีการซื้อเลข" });
  }
  const randomIndex = Math.floor(Math.random() * lotto.length);
  const randomLotto = lotto[randomIndex];
  res.json(randomLotto);
});
app.post('/winners/save', auth, isOwner, (req, res) => {
  const { winners } = req.body;

  if (!Array.isArray(winners) || winners.length === 0) {
    return res.status(400).json({ error: "Missing winners array" });
  }

  // 🟦 ดึงเลขรางวัลที่ 1 มาแยกเลขท้าย 3 ตัว
  const first = winners.find(w => w.type === "first");
  if (first && first.number.length >= 3) {
    const last3 = first.number.slice(-3); // ✅ ตัดเลขท้าย 3 ตัว
    winners.push({ type: "lastThreeDigits", number: last3 });
  }

  save(WINNERS_FILE, winners);
  res.json({ message: `Saved ${winners.length} winners (รวมเลขท้าย 3 ตัวแล้ว)` });
});
//รีเซ็ตข้อมูลผู้ถูกรางวัล
app.post("/reset-winners", auth, isOwner, (req, res) => {
  save(WINNERS_FILE, []);
  res.json({ message: "ล้างข้อมูลผู้ถูกรางวัลทั้งหมด" });
});
//whowLottowin
app.get("/lotto/winners", auth, (req, res) => {
  try {
    const lottoList = load(LOTTO_FILE) || [];

    const winners = lottoList.filter(l => l.isWinner === true);

    const winnerNumbers = winners.map(w => w.number);

    return res.json(winnerNumbers);
  } catch (error) {
    console.error("❌ Error in /lotto/winners:", error.message);
    return res.status(500).json({ error: "Server error: " + error.message });
  }
});
// API ใหม่: ดึงผลรางวัลล่าสุด
app.get("/results", (req, res) => {
  try {
    const data = load(WINNERS_FILE);
    res.json(data);
  } catch (e) {
    console.error("❌ /results error:", e);
    res.status(500).json({ error: "ไม่สามารถโหลดผลรางวัลได้" });
  }
});

app.get('/user', (req, res) => {
  res.json(users);
})
app.get('/lotto', (req, res) => {
  res.json(lotto);
})
app.get('/winners', (req, res) => {
  res.json(winners);
})

// Start server
app.listen(3001, () => {
  console.log("Lotto server running on port 3001")
});