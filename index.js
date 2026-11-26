const express = require('express');
const app = express();
const __path = process.cwd();
const bodyParser = require('body-parser');
const PORT = process.env.PORT || 8000;
const code = require('./pair');

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/code', code);

app.use('/pair', async (req, res) => {
    res.sendFile(__path + '/public/pair.html');
});

app.use('/', async (req, res) => {
    res.sendFile(__path + '/public/main.html');
});

app.listen(PORT, () => {
    console.log('ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʟᴏs-ᴋɪɴɢ-xᴍᴅ | © sʜᴀᴡɪɴ ʙᴏʏ');
    console.log('Server running on http://localhost:' + PORT);
});

module.exports = app;
