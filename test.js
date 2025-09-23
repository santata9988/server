const express = require('express');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SECRET_KEY = "MY_SECRET_KEY";

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

// Middleware ตรวจสอบ owner เท่านั้น
function isOwner(req, res, next) {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Owner only" });
  }
  next();
}

// สมัครสมาชิก
app.post("/register", (req, res) => {
  const { name, login_tel, password, wallet } = req.body;

  db.query("SELECT * FROM users WHERE login_tel = ?", [login_tel], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length > 0) return res.status(400).json({ error: "User already exists" });

    const sql = "INSERT INTO users (NAME, login_tel, PASSWORD, role, wallet) VALUES (?, ?, ?, 'member', ?)";
    db.query(sql, [name, login_tel, password, wallet], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Registered", userId: result.insertId });
    });
  });
});

// Login
app.post("/login", (req, res) => {
  const { login_tel, password } = req.body;

  db.query("SELECT * FROM users WHERE login_tel = ? AND PASSWORD = ?", [login_tel, password], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(401).json({ error: "Invalid credentials" });

    const user = results[0];
    const token = jwt.sign({ id: user.id, role: user.role, name: user.NAME }, SECRET_KEY, { expiresIn: "2h" });
    res.json({ token, user });
  });
});
app.get("/me", auth, (req, res) => {
  const user = USERS.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    id: user.id,
    name: user.name,
    wallet: user.wallet,
    role: user.role
  });
});
// ซื้อเลขล็อตโต้ (MySQL)
app.post("/lotto/buy", auth, (req, res) => {
  const { number } = req.body;

  if (!number) {
    return res.status(400).json({ error: "Missing ticket number" });
  }

  const userId = req.user.id;

  // 1. หา ticket ที่ยังไม่ขาย
  const sqlFind = "SELECT * FROM lotto_tickets WHERE number = ? AND isSold = 0 LIMIT 1";
  db.query(sqlFind, [number], (err, results) => {
    if (err) return res.status(500).json({ error: "DB error (find ticket)" });
    if (results.length === 0) {
      return res.status(400).json({ error: "Ticket not available" });
    }

    const ticket = results[0];

    // 2. หา user
    const sqlUser = "SELECT id, wallet FROM users WHERE id = ?";
    db.query(sqlUser, [userId], (err, users) => {
      if (err) return res.status(500).json({ error: "DB error (find user)" });
      if (users.length === 0) return res.status(404).json({ error: "User not found" });

      const user = users[0];

      if (user.wallet < ticket.price) {
        return res.status(400).json({ error: "Not enough balance" });
      }

      // 3. Transaction: หักเงิน + อัปเดต ticket
      db.beginTransaction(err => {
        if (err) return res.status(500).json({ error: "Transaction error" });

        const sqlUpdateWallet = "UPDATE users SET wallet = wallet - ? WHERE id = ?";
        db.query(sqlUpdateWallet, [ticket.price, userId], err => {
          if (err) return db.rollback(() => res.status(500).json({ error: "Wallet update failed" }));

          const sqlUpdateTicket = "UPDATE lotto_tickets SET isSold = 1, buyerId = ? WHERE id = ?";
          db.query(sqlUpdateTicket, [userId, ticket.id], err => {
            if (err) return db.rollback(() => res.status(500).json({ error: "Ticket update failed" }));

            db.commit(err => {
              if (err) return db.rollback(() => res.status(500).json({ error: "Commit failed" }));

              // ✅ ส่ง JSON กลับ Flutter
              res.json({
                message: "Ticket purchased",
                wallet: user.wallet - ticket.price, // กระเป๋าล่าสุด
                ticket: {
                  id: ticket.id,
                  number: ticket.number,
                  price: ticket.price
                }
              });
            });
          });
        });
      });
    });
  });
});

// ดึงข้อมูล user ตาม id
app.get("/users/:id", auth, (req, res) => {
  const sql = "SELECT id, name, login_tel, role, wallet FROM users WHERE id = ?";
  db.query(sql, [req.params.id], (err, results) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (results.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(results[0]);
  });
});
// ดึงลอตเตอรี่ที่ผู้ใช้ซื้อไปแล้ว
app.get("/users/:id/tickets", auth, (req, res) => {
  const userId = parseInt(req.params.id);

  const sql = `
    SELECT id, number, price, isSold, buyerId
    FROM lotto_tickets
    WHERE buyerId = ?
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("❌ tickets query error:", err.sqlMessage);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(results);
  });
});
// รีเซ็ตระบบ (เหลือเฉพาะ role = owner)
app.post("/reset", auth, isOwner, (req, res) => {
  db.beginTransaction(err => {
    if (err) {
      console.error("❌ Transaction error:", err.message);
      return res.status(500).json({ error: "Transaction start failed" });
    }

    // 1. ลบ users ที่ไม่ใช่ owner
    const deleteMembers = "DELETE FROM users WHERE role = 'member'";
    db.query(deleteMembers, (err) => {
      if (err) {
        return db.rollback(() => {
          console.error("❌ delete members error:", err.message);
          res.status(500).json({ error: "Database error while deleting members" });
        });
      }

      // 2. ล้างล็อตเตอรี่
      db.query("TRUNCATE TABLE lotto_tickets", (err) => {
        if (err) {
          return db.rollback(() => {
            console.error("❌ reset lotto error:", err.message);
            res.status(500).json({ error: "Database error while resetting lotto" });
          });
        }

        // 3. ล้างผู้ถูกรางวัล
        db.query("TRUNCATE TABLE winners", (err) => {
          if (err) {
            return db.rollback(() => {
              console.error("❌ reset winners error:", err.message);
              res.status(500).json({ error: "Database error while resetting winners" });
            });
          }

          // 4. Commit
          db.commit(err => {
            if (err) {
              return db.rollback(() => {
                console.error("❌ Commit error:", err.message);
                res.status(500).json({ error: "Database commit failed" });
              });
            }

            res.json({ message: "รีเซ็ตข้อมูลทั้งหมดเสร็จสิ้น (เหลือเฉพาะ owner)" });
          });
        });
      });
    });
  });
});

// รีเซ็ตรหัสผ่าน
app.post("/reset-password", (req, res) => {
  const { loginTel, newPassword } = req.body;

  if (!loginTel || !newPassword) {
    return res.status(400).json({ success: false, message: "กรุณากรอก loginTel และ newPassword" });
  }

  const sql = "UPDATE users SET password = ? WHERE login_tel = ?";

  db.query(sql, [newPassword, loginTel], (err, result) => {
    if (err) {
      console.error("❌ reset-password error:", err.message);
      return res.status(500).json({ success: false, message: "Database error" });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "ไม่พบผู้ใช้" });
    }

    res.json({ success: true, message: "เปลี่ยนรหัสผ่านสำเร็จ" });
  });
});

// ดึงข้อมูล users ทั้งหมด
app.get("/users", (req, res) => {
  db.query("SELECT * FROM users", (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// ดู wallet ของ user ตาม id
app.get("/wallet/:id", (req, res) => {
  db.query("SELECT wallet FROM users WHERE id = ?", [req.params.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(results[0]);
  });
});

// ดู lotto ที่ยังไม่ขาย
app.get("/lotto", (req, res) => {
  db.query("SELECT * FROM lotto_tickets WHERE isSold = FALSE", (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// บันทึกเลขลอตเตอรี่ 
app.post("/lotto/saveMany", (req, res) => {
  const { numbers } = req.body;

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Missing numbers array" });
  }

  // เตรียมข้อมูลใหม่
  const values = numbers.map(num => [
    String(num).padStart(6, "0"), // ครบ 6 หลัก
    80,
    false,
    null,
    false
  ]);

  // เริ่ม transaction
  db.beginTransaction(err => {
    if (err) {
      console.error("❌ Transaction error:", err);
      return res.status(500).json({ error: "Transaction start failed" });
    }

    // 1. ลบ winners เดิม
    db.query("TRUNCATE TABLE winners", (err) => {
      if (err) {
        return db.rollback(() => {
          console.error("❌ Truncate winners error:", err);
          res.status(500).json({ error: "Database error while truncating winners" });
        });
      }

      // 2. ลบ lotto เดิม
      db.query("TRUNCATE TABLE lotto_tickets", (err) => {
        if (err) {
          return db.rollback(() => {
            console.error("❌ Truncate lotto error:", err);
            res.status(500).json({ error: "Database error while truncating lotto" });
          });
        }

        // 3. บันทึกข้อมูลใหม่
        const sql = `
          INSERT INTO lotto_tickets (number, price, isSold, buyerId, claimed)
          VALUES ?
        `;
        db.query(sql, [values], (err, result) => {
          if (err) {
            return db.rollback(() => {
              console.error("❌ Insert error:", err);
              res.status(500).json({ error: "Database error while inserting lotto" });
            });
          }

          // 4. Commit
          db.commit(err => {
            if (err) {
              return db.rollback(() => {
                console.error("❌ Commit error:", err);
                res.status(500).json({ error: "Database commit failed" });
              });
            }

            res.json({
              message: `Saved ${numbers.length} lotto numbers (ลบเก่า + ลบ winners + บันทึกใหม่แล้ว)`,
              inserted: result.affectedRows
            });
          });
        });
      });
    });
  });
});

// winner
app.post('/winners/save', auth, isOwner, (req, res) => {
  const { winners, lastTwoDigits } = req.body;

  if (!Array.isArray(winners) || winners.length === 0) {
    return res.status(400).json({ error: "Missing winners array" });
  }

  // ตารางรางวัลกับเงิน
  const prizeMap = {
    first: 6000000,
    second: 200000,
    third: 80000,
    fourth: 4000,
    fifth: 2000,
    lastTwoDigits: 2000,
    lastThreeDigits: 4000
  };

  // 🟦 ดึงเลขรางวัลที่ 1 มาแยกเลขท้าย 3 ตัว
  const first = winners.find(w => w.type === "first");
  if (first && first.number.length >= 3) {
    const last3 = first.number.slice(-3);
    winners.push({ type: "lastThreeDigits", number: last3 });
  }

  // 🟦 เพิ่มเลขท้าย 2 ตัว (ถ้ามี)
  let last2 = null;
  if (lastTwoDigits !== undefined && lastTwoDigits !== null) {
    last2 = String(lastTwoDigits).padStart(2, "0");
    winners.push({ type: "lastTwoDigits", number: last2 });
  }

  // เตรียม values สำหรับบันทึก
  const values = winners.map(w => [
    w.type,
    w.number,
    prizeMap[w.type] || 0
  ]);

  db.beginTransaction(err => {
    if (err) return res.status(500).json({ error: "Transaction start failed" });

    // 1. ล้าง winners เก่า
    db.query("TRUNCATE TABLE winners", err => {
      if (err) return db.rollback(() => res.status(500).json({ error: "Clear winners failed" }));

      // 2. Insert winners ใหม่
      const sql = "INSERT INTO winners (type, number, reward) VALUES ?";
      db.query(sql, [values], (err, result) => {
        if (err) return db.rollback(() => res.status(500).json({ error: "Insert winners failed" }));

        // 3. Reset prizeType ทั้งหมด
        db.query("UPDATE lotto_tickets SET prizeType = 'none'", err => {
          if (err) return db.rollback(() => res.status(500).json({ error: "Reset lotto failed" }));

          // 4. อัปเดตตามแต่ละรางวัล
          let updates = [];

          // รางวัลที่ 1–5 → ตรงเลขเต็ม
          ["first","second","third","fourth","fifth"].forEach(type => {
            const prize = winners.find(w => w.type === type);
            if (prize) {
              updates.push(new Promise((resolve,reject)=>{
                db.query(
                  "UPDATE lotto_tickets SET prizeType = ? WHERE number = ?",
                  [type, prize.number],
                  (err, result) => err ? reject(err) : resolve(result.affectedRows)
                );
              }));
            }
          });

          // เลขท้าย 3 ตัว
          const last3 = winners.find(w => w.type === "lastThreeDigits");
          if (last3) {
            updates.push(new Promise((resolve,reject)=>{
              db.query(
                "UPDATE lotto_tickets SET prizeType = 'lastThreeDigits' WHERE RIGHT(number,3) = ?",
                [last3.number],
                (err, result) => err ? reject(err) : resolve(result.affectedRows)
              );
            }));
          }

          // เลขท้าย 2 ตัว
          if (last2) {
            updates.push(new Promise((resolve,reject)=>{
              db.query(
                "UPDATE lotto_tickets SET prizeType = 'lastTwoDigits' WHERE RIGHT(number,2) = ?",
                [last2],
                (err, result) => err ? reject(err) : resolve(result.affectedRows)
              );
            }));
          }

          // รันทั้งหมด
          Promise.all(updates)
            .then(rows => {
              db.commit(err => {
                if (err) return db.rollback(() => res.status(500).json({ error: "Commit failed" }));

                res.json({
                  message: "บันทึกรางวัลและอัปเดตล็อตเตอรี่สำเร็จ",
                  inserted: result.affectedRows,
                  matchedTickets: rows.reduce((a,b)=>a+b,0)
                });
              });
            })
            .catch(err => {
              db.rollback(()=>res.status(500).json({ error: "Update lotto failed" }));
            });
        });
      });
    });
  });
});
app.get('/lotto/randomSell', auth, isOwner, (req, res) => {
  const sql = "SELECT * FROM lotto_tickets WHERE isSold = TRUE";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ randomSell error:", err.message);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      return res.status(400).json({ error: "ยังไม่มีการซื้อเลข" });
    }
    const randomIndex = Math.floor(Math.random() * results.length);
    res.json(results[randomIndex]);
  });
});
app.get('/lotto/randomAll', auth, isOwner, (req, res) => {
  const sql = "SELECT number FROM lotto_tickets ORDER BY RAND() LIMIT 1";

  db.query(sql, (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (results.length === 0) {
      return res.status(400).json({ error: "No lotto numbers available" });
    }

    // ✅ ส่งเฉพาะเลข
    res.json({ number: results[0].number });
  });
});

app.get("/lotto/winners", auth, (req, res) => {
  const sql = "SELECT number FROM winners";

  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ Error in /lotto/winners:", err.message);
      return res.status(500).json({ error: "Database error: " + err.message });
    }

    // แปลงผลลัพธ์ให้เป็น array ของเลขรางวัล
    const winnerNumbers = results.map(r => r.number);

    res.json(winnerNumbers);
  });
});
// ดึงลอตเตอรี่ทั้งหมด
app.get("/lotto", auth, (req, res) => {
  const sql = `
    SELECT 
      id,
      number,
      price,
      (isSold = 1) AS isSold,      -- ✅ คืนเป็น true/false
      buyerId,
      (claimed = 1) AS claimed,    -- ✅ คืนเป็น true/false
      created_at
    FROM lotto_tickets
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ lotto error:", err.message);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(results); // ✅ [{"id":1,"number":"563120","isSold":false,...}]
  });
});

// ดึงผู้ถูกรางวัล
app.get("/winners", auth, (req, res) => {
  const sql = "SELECT type, number, reward FROM winners";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ winners error:", err.message);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(results); // ✅ [{"type":"first","number":"563120","reward":6000000}, ...]
  });
});




// รีเซ็ตข้อมูลลอตเตอรี่
app.post("/reset-lotto", auth, isOwner, (req, res) => {
  const sql = "TRUNCATE TABLE lotto_tickets"; // ล้างข้อมูล + รีเซ็ต AUTO_INCREMENT

  db.query(sql, (err, result) => {
    if (err) {
      console.error("❌ reset-lotto error:", err.message);
      return res.status(500).json({ error: "Database error: " + err.message });
    }
    res.json({ message: "ล้างข้อมูลล็อตเตอรี่ทั้งหมด" });
  });
});
// รีเซ็ตข้อมูลผู้ถูกรางวัล
app.post("/reset-winners", auth, isOwner, (req, res) => {
  const sql = "TRUNCATE TABLE winners"; // ✅ ลบข้อมูลทั้งหมด + รีเซ็ต AUTO_INCREMENT

  db.query(sql, (err, result) => {
    if (err) {
      console.error("❌ reset-winners error:", err.message);
      return res.status(500).json({ error: "Database error while resetting winners" });
    }

    res.json({ message: "ล้างข้อมูลผู้ถูกรางวัลทั้งหมดแล้ว" });
  });
});


app.listen(3000, () => {
  console.log("🚀 Server running at http://localhost:3000");
});