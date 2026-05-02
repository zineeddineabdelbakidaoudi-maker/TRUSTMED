const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  const res1 = await axios.get('https://dzdoc.com/recherche.php?nom=Djermoun', { headers: {'User-Agent':'Mozilla/5.0'} });
  const $1 = cheerio.load(res1.data);
  $1('div.doc-list').each((i, el) => {
    console.log('dzdoc ---');
    console.log($1(el).text().replace(/\s+/g, ' '));
  });

  const res2 = await axios.get('https://algerie-docto.com/search?q=Djermoun', { headers: {'User-Agent':'Mozilla/5.0'} });
  const $2 = cheerio.load(res2.data);
  $2('.doctor-card, .search-result, .card, .medecin').each((i, el) => {
    console.log('algerie-docto ---');
    console.log($2(el).text().replace(/\s+/g, ' '));
  });
}
test();
