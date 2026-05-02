const axios = require('axios');
const cheerio = require('cheerio');

const urls = [
  'https://www.sorm-cne.dz/annuaire',
  'https://sormdalger.com/annuaire',
  'https://sorm-blida.dz/annuaire',
  'https://crom-tiziouzou.dz/annuaire',
  'https://ordre-medecins-setif.dz/annuaire',
  'https://annumed.sante-dz.com/annuaire',
  'https://www.1sante.com/online/annuaire-par-wilaya/',
  'https://dzdoc.com/recherche',
  'https://algerie-docto.com/recherche',
  'https://esiha.net/recherche'
];

async function check() {
  console.log('--- START RESEARCH ---');
  for (const url of urls) {
    try {
      const res = await axios.get(url, { 
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const $ = cheerio.load(res.data);
      const title = $('title').text().trim();
      
      const forms = [];
      $('form').each((i, el) => {
        const action = $(el).attr('action') || 'SELF';
        const method = $(el).attr('method') || 'GET';
        const inputs = [];
        $(el).find('input, select').each((j, input) => {
          inputs.push($(input).attr('name') || 'unnamed');
        });
        forms.push(`${method.toUpperCase()} ${action} [${inputs.join(', ')}]`);
      });

      console.log(`[ONLINE] ${url}`);
      console.log(`  Title: ${title}`);
      console.log(`  Forms: ${forms.length > 0 ? forms.join(' | ') : 'No forms found'}`);
      
    } catch (e) {
      console.log(`[FAILED] ${url} - ${e.response ? e.response.status : e.message}`);
    }
  }
}

check();
