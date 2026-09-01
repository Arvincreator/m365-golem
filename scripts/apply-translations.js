const fs = require('fs');
const path = require('path');

const PERSONAS_DIR = path.resolve(__dirname, '..', 'data', 'marketplace', 'personas');
const TRANSLATED_DIR = path.resolve(__dirname, '..', 'tmp', 'translation_batches');

function main() {
    const translatedFiles = fs.readdirSync(TRANSLATED_DIR).filter(f => f.endsWith('_translated.json'));
    
    // Group all translations by file
    const updatesByFile = {};

    translatedFiles.forEach(tf => {
        const translations = JSON.parse(fs.readFileSync(path.join(TRANSLATED_DIR, tf), 'utf8'));
        translations.forEach(t => {
            if (!updatesByFile[t.file]) updatesByFile[t.file] = {};
            updatesByFile[t.file][t.id] = t;
        });
    });

    // Apply updates
    for (const [fileName, updates] of Object.entries(updatesByFile)) {
        const filePath = path.join(PERSONAS_DIR, fileName);
        if (!fs.existsSync(filePath)) continue;

        const personas = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let changed = false;

        personas.forEach(p => {
            if (updates[p.id]) {
                const up = updates[p.id];
                p.name_zh = up.name_zh;
                p.description_zh = up.description_zh;
                p.role_zh = up.role_zh;
                if (!p.tags.includes('zh')) {
                    p.tags.push('zh');
                }
                changed = true;
            }
        });

        if (changed) {
            fs.writeFileSync(filePath, JSON.stringify(personas, null, 2));
            console.log(`Updated ${fileName} with new translations.`);
        }
    }
}

main();
