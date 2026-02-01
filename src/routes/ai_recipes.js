import express from 'express';
import { db } from '../db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const router = express.Router();

// ------------------------------------------------------------------
// RUTA 1: SUGERIR (/suggest)
// El usuario manda ingredientes -> La IA da 3 ideas de títulos
// ------------------------------------------------------------------
router.post('/suggest', async (req, res) => {
    try {
        const { ingredients } = req.body; // Ej: ["pollo", "papas"]
        const apiKey = process.env.GROQ_API_KEY;

        if (!ingredients || ingredients.length === 0) {
            return res.status(400).json({ error: "Faltan ingredientes" });
        }

        // Prompt simple para pedir ideas
        const systemPrompt = `
            Eres un Chef. Tienes estos ingredientes: ${ingredients.join(', ')}.
            Sugiere 3 nombres de platos creativos pero realistas.
            Responde SOLO JSON: { "suggestions": [{ "title": "Nombre 1", "description": "Breve desc" }, ...] }
        `;

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: "system", content: systemPrompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();
        const content = JSON.parse(data.choices[0].message.content);
        
        res.json(content); // Enviamos las 3 opciones al frontend

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error sugiriendo recetas" });
    }
});

// ------------------------------------------------------------------
// RUTA 2: COCINAR (/generate)
// El usuario elige un Título -> Buscamos en BD o Creamos con IA
// ------------------------------------------------------------------
router.post('/generate', async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { selected_title, available_ingredients } = req.body;
        
        // 1. ¿YA EXISTE EN LA BASE DE DATOS?
        const [existing] = await connection.query(
            'SELECT * FROM recipes WHERE title = ? LIMIT 1',
            [selected_title]
        );

        if (existing.length > 0) {
            // ¡SÍ EXISTE! La devolvemos sin molestar a la IA
            console.log("♻️ Receta encontrada en BD:", selected_title);
            
            // Buscamos sus ingredientes
            const [dbIngredients] = await connection.query(`
                SELECT i.name, ri.quantity, i.unit 
                FROM ingredients i
                JOIN recipe_ingredients ri ON i.ingredient_id = ri.ingredient_id
                WHERE ri.recipe_id = ?`, 
                [existing[0].recipe_id]
            );

            connection.release();
            return res.json({
                message: "Receta recuperada de Base de Datos",
                recipe: existing[0],
                ingredients: dbIngredients
            });
        }

        // 2. NO EXISTE -> LA CREAMOS CON IA
        console.log("🤖 Creando nueva receta con IA:", selected_title);
        const apiKey = process.env.GROQ_API_KEY;
        
        const systemPrompt = `
            Genera la receta completa para: "${selected_title}".
            Usa preferiblemente: ${available_ingredients ? available_ingredients.join(', ') : 'ingredientes estándar'}.
            Responde SOLO JSON:
            {
                "recipe": { "title": "${selected_title}", "description": "...", "instructions": "...", "difficulty": "media", "preparation_time": 30, "servings": 2, "calories_per_serving": 500 },
                "ingredients": [{ "name": "...", "quantity": 1, "unit": "...", "category": "..." }]
            }
        `;

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: "system", content: systemPrompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.3,
                response_format: { type: "json_object" }
            })
        });

        const jsonRes = await response.json();
        const aiData = JSON.parse(jsonRes.choices[0].message.content);

        // 3. GUARDAMOS EN BD
        await connection.beginTransaction();

        // Insertar Receta
        const [resReceta] = await connection.query(
            `INSERT INTO recipes (title, description, instructions, difficulty, preparation_time, servings, calories_per_serving, created_by, family_id, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 'placeholder')`,
            [aiData.recipe.title, aiData.recipe.description, aiData.recipe.instructions, aiData.recipe.difficulty, aiData.recipe.preparation_time, aiData.recipe.servings, aiData.recipe.calories_per_serving]
        );
        const recipeId = resReceta.insertId;

        // Insertar Ingredientes
        if (aiData.ingredients) {
            for (const ing of aiData.ingredients) {
                const cleanName = ing.name.trim().charAt(0).toUpperCase() + ing.name.slice(1).toLowerCase();
                
                // Buscar o Crear ingrediente
                const [existIng] = await connection.query('SELECT ingredient_id FROM ingredients WHERE name = ?', [cleanName]);
                let ingId;
                
                if (existIng.length > 0) {
                    ingId = existIng[0].ingredient_id;
                } else {
                    const [newIng] = await connection.query('INSERT INTO ingredients (name, unit) VALUES (?, ?)', [cleanName, ing.unit || 'u']);
                    ingId = newIng.insertId;
                }

                // Relacionar
                await connection.query('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity) VALUES (?, ?, ?)', [recipeId, ingId, ing.quantity]);
            }
        }

        await connection.commit();

        res.json({
            message: "Nueva receta creada por IA",
            recipe: aiData.recipe,
            ingredients: aiData.ingredients
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error(error);
        res.status(500).json({ error: "Error generando receta" });
    } finally {
        if (connection) connection.release();
    }
});