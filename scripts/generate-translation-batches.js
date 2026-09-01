const fs = require('fs');
const path = require('path');

const PERSONAS_DIR = path.resolve(__dirname, '..', 'data', 'marketplace', 'personas');
const BATCH_SIZE = 40;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'translation_batches');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function main() {
    const files = fs.readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.json'));
    let missingItems = [];

    files.forEach(file => {
        const filePath = path.join(PERSONAS_DIR, file);
        const personas = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        personas.forEach(p => {
            if (!p.name_zh) {
                missingItems.push({
                    file,
                    id: p.id,
                    name: p.name,
                    role: p.role || p.description // Use role if available, else description
                });
            }
        });
    });

    console.log(`Found ${missingItems.length} items missing translations.`);

    for (let i = 0; i < missingItems.length; i += BATCH_SIZE) {
        const batch = missingItems.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const outputPath = path.join(OUTPUT_DIR, `batch_${batchNum}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(batch, null, 2));
        console.log(`Created ${outputPath}`);
    }
}

main();
