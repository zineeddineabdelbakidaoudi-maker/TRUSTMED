const axios = require('axios');
require('dotenv').config();

async function listModels() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log("No GEMINI_API_KEY found in .env");
    return;
  }
  
  try {
    const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    console.log("Available Models:");
    res.data.models.forEach(m => {
      console.log(`- ${m.name} (generateContent: ${m.supportedGenerationMethods.includes('generateContent')})`);
    });
  } catch (err) {
    console.error("Error fetching models:", err.response?.data || err.message);
  }
}

listModels();
