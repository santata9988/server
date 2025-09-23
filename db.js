const mysql = require('mysql2');

// สร้าง connection
const connection = mysql.createConnection({
  host: '202.28.34.203',                // ถ้าเป็น hosting อื่น อาจต้องใส่ IP หรือ domain
  user: 'mb68_66011212004',
  password: 'sC9r1%@oy7cg',
  database: 'mb68_66011212004',
  decimalNumbers: true,   // ✅ ทำให้ DECIMAL/NUMERIC กลายเป็น Number อัตโนมัติ
  connectionLimit: 10,   // มี connection สำรอง
  queueLimit: 0
});

// ทดสอบการเชื่อมต่อ
connection.connect((err) => {
  if (err) {
    console.error('❌ เชื่อมต่อ MySQL ไม่ได้: ' + err.message);
    return;
  }
  console.log('✅ MySQL Connected as ID ' + connection.threadId);
});

module.exports = connection;