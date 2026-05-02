const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  const res = await axios.get('https://www.1sante.com/online/?s=Djermoun', { headers: {'User-Agent':'Mozilla/5.0'} });
  const $ = cheerio.load(res.data);
  $('article').each((i, el) => {
    console.log('---');
    console.log($(el).text().replace(/\s+/g, ' '));
  });
}
test();
