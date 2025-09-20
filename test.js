const express = require('express')
const app = express()

app.get('/', (req, res) => {
  res.send('Hello World!')
})

// ต้องมีบรรทัดนี้เพื่อรัน server
app.listen(3000, () => {
  console.log('Server running at http://localhost:3000/')
})