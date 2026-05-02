require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OcrService = require('./services/ocr/OcrService');
const FraudDetector = require('./services/ocr/FraudDetector');
const VisionVerificationService = require('./services/ocr/VisionVerificationService');

async function runTest() {
  const folderPath = process.argv[2] || './test_images';
  const expectedName = process.argv[3] || 'TEST PRACTITIONER';

  if (!fs.existsSync(folderPath)) {
    console.error(`Error: Folder not found at ${folderPath}`);
    process.exit(1);
  }

  const ocr = new OcrService();
  const detector = new FraudDetector();
  const visionService = new VisionVerificationService();
  const files = fs.readdirSync(folderPath).filter(f => /\.(jpg|jpeg|png|pdf)$/i.test(f));

  if (files.length === 0) {
    console.log('No images found in folder.');
    return;
  }

  console.log(`\n=== TrustMed OCR & Fraud Test ===`);
  console.log(`Folder: ${folderPath}`);
  console.log(`Target Practitioner: ${expectedName}`);
  console.log(`Files found: ${files.length}\n`);

  const mockProfile = {
    id: 'test-uuid-000',
    full_name: expectedName,
    wilaya_code: 16
  };

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(file).toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' : `image/${ext.replace('.', '')}`;

    console.log(`Processing: ${file}...`);
    
    try {
      // 1. Run OCR (will fallback to Tesseract if Azure keys missing in .env)
      const ocrResult = await ocr.analyzeDocument(buffer, mimeType, 'DIPLOMA');
      
      // 2. Run Fraud Detection
      const fraudResult = detector.detectFraud(ocrResult.extracted_fields, 'DIPLOMA', mockProfile, buffer);

      // 3. Run Vision AI Verification
      console.log(`  > Running Multi-Model Vision Verification...`);
      try {
        const visionResult = await visionService.evaluateDiploma(buffer, mimeType);
        if (!visionResult.is_authentic) {
          fraudResult.flags.push({
            check: 'VISION_AI_REJECTION',
            severity: 'HIGH',
            score_penalty: 50,
            details: visionResult
          });
          fraudResult.fraud_score = Math.max(0, fraudResult.fraud_score - 50);
          fraudResult.recommendation = 'FREEZE';
        }
        console.log(`  > Vision AI Score: ${visionResult.score} (${visionResult.consensus_reason})`);
      } catch (e) {
        console.log(`  > Vision AI Skipped: ${e.message} (Are API keys set?)`);
      }

      console.log(`  > Source: ${ocrResult.source || 'AZURE_DOC_INTEL'}`);
      console.log(`  > Extracted Name: ${ocrResult.extracted_fields.full_name || ocrResult.extracted_fields.graduate_name || 'NOT_FOUND'}`);
      console.log(`  > Fraud Score: ${fraudResult.fraud_score}/100`);
      console.log(`  > Recommendation: ${fraudResult.recommendation}`);
      
      if (fraudResult.flags.length > 0) {
        console.log(`  > Flags detected:`);
        fraudResult.flags.forEach(f => console.log(`    - [${f.severity}] ${f.check}: ${JSON.stringify(f.details)}`));
      }
      
      const status = fraudResult.recommendation === 'FREEZE' ? '❌ FAKE/SUSPICIOUS' : '✅ LIKELY REAL';
      console.log(`  > STATUS: ${status}\n`);

    } catch (err) {
      console.error(`  > Error processing ${file}: ${err.message}\n`);
    }
  }

  console.log(`=== Test Complete ===`);
}

runTest().catch(console.error);
