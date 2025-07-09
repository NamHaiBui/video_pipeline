#!/usr/bin/env node
/**
 * Quick script to check the current database schema
 */

import { config } from 'dotenv';
import { createRDSService } from './dist/lib/rdsService.js';

// Load environment variables
config();

async function checkDatabaseSchema() {
    const rdsService = createRDSService();
    
    try {
        // Check Episodes table schema
        const schemaQuery = `
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = 'Episodes' 
            ORDER BY ordinal_position;
        `;
        
        const result = await rdsService.executeQuery(schemaQuery, []);
        
        console.log('📊 Current Episodes table schema:');
        console.log('═══════════════════════════════════════════════════════════════════════════════');
        if (result && result.rows) {
            result.rows.forEach(row => {
                const nullable = row.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
                console.log(`   ${row.column_name.padEnd(25)} | ${row.data_type.padEnd(20)} | ${nullable}`);
            });
        } else {
            console.log('❌ No schema data returned');
            console.log('Result:', result);
        }
        
        // Check if we have any episodes
        const countQuery = 'SELECT COUNT(*) as count FROM "Episodes"';
        const countResult = await rdsService.executeQuery(countQuery, []);
        if (countResult && countResult.length > 0) {
            console.log(`\n📈 Total episodes in database: ${countResult[0].count}`);
        } else {
            console.log(`\n📈 Could not get episode count`);
        }
        
    } catch (error) {
        console.error('❌ Error checking schema:', error.message);
    }
}

checkDatabaseSchema().catch(console.error);
