const express = require('express');
const axios = require('axios');
const { Client } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;

// 1) Middlewares
app.use(cors());
app.use(express.json());

// 2) PostgreSQL connection
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
client.connect();

// 3) Kakao REST API Key
const KAKAO_REST_API_KEY = 'e827a92304992a479b2fa3c6bd3bf5ad';

// Helper function to parse Kakao doc
function parseKakaoDoc(doc) {
  const road = doc.road_address;
  const addr = doc.address;

  let siDo, siGunGu, eupMyeonDong, postalCode, roadName, lon, lat;

  if (road) {
    siDo         = road.region_1depth_name;   // e.g. "인천"
    siGunGu      = road.region_2depth_name;   // e.g. "남동구"
    eupMyeonDong = road.region_3depth_name;   // e.g. "논현동"
    postalCode   = road.zone_no;              // e.g. "21657"
    roadName     = road.road_name + ' ' + (road.main_building_no || '');
    lon = parseFloat(road.x);
    lat = parseFloat(road.y);
  } else {
    // fallback to 'address' if no road_address
    siDo         = addr.region_1depth_name;
    siGunGu      = addr.region_2depth_name;
    eupMyeonDong = addr.region_3depth_name;
    postalCode   = '';
    roadName     = '';
    lon = parseFloat(addr.x);
    lat = parseFloat(addr.y);
  }

  return {
    siDo,
    siGunGu,
    eupMyeonDong,
    postalCode,
    roadName,
    lon,
    lat
  };
}

// 4) POST /api/restaurants - upsert with Kakao geocoding
app.post('/api/restaurants', async (req, res) => {
  try {
    const {
      name,
      address, // full address
      english_speaking,
      vegan,
      vegetarian,
      no_pork,
      halal,
      no_beef,
      gluten_free,
      allows_foreigners
    } = req.body;

    // A) Call Kakao geocoding
    const kakaoUrl = 'https://dapi.kakao.com/v2/local/search/address.json';
    const headers = { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` };
    const params = { query: address };

    const response = await axios.get(kakaoUrl, { headers, params });
    const docs = response.data.documents;
    
    if (!docs || docs.length === 0) {
      return res.status(400).json({ message: 'Kakao: No results for that address' });
    }

    // B) Parse the first doc
    const parsed = parseKakaoDoc(docs[0]);
    const { siDo, siGunGu, eupMyeonDong, postalCode, roadName, lon, lat } = parsed;

    // C) Upsert into "restaurants"
    //    On conflict (name) => update
    const upsertSql = `
      INSERT INTO restaurants (
        name,
        english_speaking,
        vegan,
        vegetarian,
        no_pork,
        halal,
        no_beef,
        gluten_free,
        allows_foreigners,
        "si/do",
        "si/gun/gu",
        "eup/myeon/dong",
        "postal code",
        "road name",
        full_address,
        geom
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15,
        ST_SetSRID(ST_MakePoint($16, $17), 4326)::geography
      )
      ON CONFLICT (name)
      DO UPDATE SET
        english_speaking = EXCLUDED.english_speaking,
        vegan = EXCLUDED.vegan,
        vegetarian = EXCLUDED.vegetarian,
        no_pork = EXCLUDED.no_pork,
        halal = EXCLUDED.halal,
        no_beef = EXCLUDED.no_beef,
        gluten_free = EXCLUDED.gluten_free,
        allows_foreigners = EXCLUDED.allows_foreigners,
        "si/do" = EXCLUDED."si/do",
        "si/gun/gu" = EXCLUDED."si/gun/gu",
        "eup/myeon/dong" = EXCLUDED."eup/myeon/dong",
        "postal code" = EXCLUDED."postal code",
        "road name" = EXCLUDED."road name",
        full_address = EXCLUDED.full_address,
        geom = EXCLUDED.geom
      RETURNING id
    `;

    const values = [
      name,
      english_speaking,
      vegan,
      vegetarian,
      no_pork,
      halal,
      no_beef,
      gluten_free,
      allows_foreigners,
      siDo,
      siGunGu,
      eupMyeonDong,
      postalCode,
      roadName,
      address,
      lon,
      lat
    ];

    const upsertRes = await client.query(upsertSql, values);
    const newId = upsertRes.rows[0].id;

    res.json({ success: true, id: newId });
  } catch (err) {
    console.error('Error in POST /api/restaurants:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/restaurants
// Usage examples:
//   /api/restaurants?name=MyRestaurant --> checks exact name match
//   /api/restaurants                   --> returns all restaurants
app.get('/api/restaurants', async (req, res) => {
  try {
    const { 
      name,
      english_speaking,
      vegan,
      vegetarian,
      no_pork,
      halal,
      no_beef,
      gluten_free,
      allows_foreigners,
      minLat, 
      maxLat, 
      minLon, 
      maxLon
    } = req.query;

    // Parse bounding box floats
    const minLatF = parseFloat(minLat);
    const maxLatF = parseFloat(maxLat);
    const minLonF = parseFloat(minLon);
    const maxLonF = parseFloat(maxLon);

    // We'll build a list of conditions and values for the WHERE clause
    let conditions = [];
    let values = [];

    // A) If bounding box is provided, filter geometry
    //    "geom::geometry && ST_MakeEnvelope(xMin, yMin, xMax, yMax, SRID)"
    //    Note the order: ST_MakeEnvelope(minLon, minLat, maxLon, maxLat, 4326)
    if (!isNaN(minLatF) && !isNaN(maxLatF) && !isNaN(minLonF) && !isNaN(maxLonF)) {
      conditions.push(`
        geom::geometry && ST_MakeEnvelope(
          $${values.length+1}, 
          $${values.length+2}, 
          $${values.length+3}, 
          $${values.length+4}, 
          4326
        )
      `);
      // The order here is [minLon, minLat, maxLon, maxLat]
      values.push(minLonF, minLatF, maxLonF, maxLatF);
    }

    // B) Partial name match (case-insensitive)
    if (name) {
      conditions.push(`name ILIKE $${values.length + 1}`);
      values.push(`%${name}%`);
    }

    // Helper: parse 'true'/'false' from query strings into booleans
    function parseBool(val) {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return null;
    }

    // Helper: Add a boolean condition if param is provided
    function addBoolCondition(column, queryVal) {
      const parsed = parseBool(queryVal);
      if (parsed !== null) {
        conditions.push(`${column} = $${values.length + 1}`);
        values.push(parsed);
      }
    }

    // Add conditions for each boolean attribute
    addBoolCondition('english_speaking', english_speaking);
    addBoolCondition('vegan', vegan);
    addBoolCondition('vegetarian', vegetarian);
    addBoolCondition('no_pork', no_pork);
    addBoolCondition('halal', halal);
    addBoolCondition('no_beef', no_beef);
    addBoolCondition('gluten_free', gluten_free);
    addBoolCondition('allows_foreigners', allows_foreigners);

    // C) Build final SELECT
    //    We extract lat/lon from geom using ST_X, ST_Y for easy marker placement
    let sql = `
      SELECT
        id,
        name,
        english_speaking,
        vegan,
        vegetarian,
        no_pork,
        halal,
        no_beef,
        gluten_free,
        allows_foreigners,
        full_address,
        ST_X(geom::geometry) AS lon,
        ST_Y(geom::geometry) AS lat
      FROM restaurants
    `;

    // Add WHERE if we have any conditions
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY id ASC';

    // D) Execute
    const { rows } = await client.query(sql, values);

    // E) Return array of matching rows (each has lat, lon, booleans, etc.)
    res.json(rows);

  } catch (err) {
    console.error('Error in GET /api/restaurants:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/api/discount-events', async (req, res) => {
  try {
    // Example: return everything
    const queryText = 'SELECT * FROM discount_events ORDER BY created_at DESC';
    const result = await client.query(queryText);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error in GET /api/discount-events:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/stores', async (req, res) => {
  try {
    const { store_name, address, store_hours } = req.body;
    
    if (!store_name || !address) {
      return res.status(400).json({ message: 'Missing store_name or address' });
    }

    // Insert into "stores" table
    const insertSql = `
      INSERT INTO stores (store_name, address, store_hours)
      VALUES ($1, $2, $3)
      RETURNING id, store_name, address, store_hours
    `;
    const values = [store_name, address, store_hours];

    const result = await client.query(insertSql, values);
    const newStore = result.rows[0];

    // Return something like { success: true, id: newStore.id }
    return res.json({
      success: true,
      id: newStore.id,
      store_name: newStore.store_name,
      address: newStore.address
    });
  } catch (err) {
    console.error('Error in POST /api/stores:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/stores
// Usage: /api/stores?searchName=MyStore
// If ?searchName is present, we try to find a store by partial match on store_name.
// If we find one, return { exists: true, id, store_name, address }.
// Otherwise, return { exists: false }.
// If no searchName is provided, just return all stores.
app.get('/api/stores', async (req, res) => {
  try {
    const { searchName } = req.query;

    // If no searchName, return all stores (or you could choose to return an error instead).
    if (!searchName) {
      const allStoresQuery = 'SELECT * FROM stores ORDER BY id ASC';
      const { rows } = await client.query(allStoresQuery);
      return res.json(rows); // an array of all stores
    }

    // Otherwise, search for a store by name (case-insensitive, partial match).
    // If you'd prefer exact match, use: store_name ILIKE $1
    const searchSql = `
      SELECT id, store_name, address
      FROM stores
      WHERE store_name ILIKE $1
      LIMIT 1
    `;
    const { rows } = await client.query(searchSql, [`%${searchName}%`]);

    if (rows.length === 0) {
      // No matching store found
      return res.json({ exists: false });
    }

    // Found at least one store; return the first match
    const store = rows[0];
    return res.json({
      exists: true,
      id: store.id,
      store_name: store.store_name,
      address: store.address
    });
  } catch (err) {
    console.error('Error in GET /api/stores:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/discount-events', async (req, res) => {
  try {
    const {
      store_id,
      item_name,
      item_category,
      reason,
      original_price,
      discount_price,
      discount_percentage,
      discount_start,
      discount_end,
      expiration_date,
      quantity,
      item_image_url,
      posted_by,
      store_hours,
      dietary_tags,    // must be an array if using TEXT[] in DB
      is_crowd_sourced,
      avg_rating,
      total_reviews,
    } = req.body;

    // We insert the row normally; the check constraint ensures at least one discount field is present.
    // The trigger calculates the missing field if only one discount field is provided.
    const insertSql = `
      INSERT INTO discount_events (
        store_id,
        item_name,
        item_category,
        reason,
        original_price,
        discount_price,
        discount_percentage,
        discount_start,
        discount_end,
        expiration_date,
        quantity,
        item_image_url,
        posted_by,
        store_hours,
        dietary_tags,
        is_crowd_sourced,
        avg_rating,
        total_reviews
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18
      )
      RETURNING *;
    `;
    const values = [
      store_id,
      item_name,
      item_category || null,
      reason || null,
      original_price,
      discount_price,
      discount_percentage,
      discount_start || null,
      discount_end || null,
      expiration_date || null,
      quantity || null,
      item_image_url || null,
      posted_by || null,
      store_hours || null,
      dietary_tags || null,
      is_crowd_sourced !== undefined ? is_crowd_sourced : true,
      avg_rating || null,
      total_reviews || 0,
    ];

    const result = await client.query(insertSql, values);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in POST /api/discount-events:', err);
    // If you violated the check constraint, you'll get a 500 with the relevant error here.
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
});

app.get('/api/discount-events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const queryText = 'SELECT * FROM discount_events WHERE id = $1';
    const result = await client.query(queryText, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Discount event not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in GET /api/discount-events/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.put('/api/discount-events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      store_id,
      item_name,
      item_category,
      reason,
      original_price,
      discount_price,
      discount_percentage,
      discount_start,
      discount_end,
      expiration_date,
      quantity,
      item_image_url,
      posted_by,
      store_hours,
      dietary_tags,
      is_crowd_sourced,
      avg_rating,
      total_reviews,
    } = req.body;

    // We'll construct a dynamic update. Simpler approach: update all columns blindly.
    const updateSql = `
      UPDATE discount_events
      SET
        store_id = $1,
        item_name = $2,
        item_category = $3,
        reason = $4,
        original_price = $5,
        discount_price = $6,
        discount_percentage = $7,
        discount_start = $8,
        discount_end = $9,
        expiration_date = $10,
        quantity = $11,
        item_image_url = $12,
        posted_by = $13,
        store_hours = $14,
        dietary_tags = $15,
        is_crowd_sourced = $16,
        avg_rating = $17,
        total_reviews = $18,
        updated_at = NOW()
      WHERE id = $19
      RETURNING *;
    `;
    const values = [
      store_id,
      item_name,
      item_category || null,
      reason || null,
      original_price,
      discount_price,
      discount_percentage,
      discount_start || null,
      discount_end || null,
      expiration_date || null,
      quantity || null,
      item_image_url || null,
      posted_by || null,
      store_hours || null,
      dietary_tags || null,
      is_crowd_sourced !== undefined ? is_crowd_sourced : true,
      avg_rating || null,
      total_reviews || 0,
      id
    ];

    const result = await client.query(updateSql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Discount event not found or no changes made' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in PUT /api/discount-events/:id:', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  }
});

app.delete('/api/discount-events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteSql = 'DELETE FROM discount_events WHERE id = $1 RETURNING *';
    const result = await client.query(deleteSql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Discount event not found' });
    }
    return res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error in DELETE /api/discount-events/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// ============= COMMUNITY ROUTES ============= //
//
// These routes assume you have created 4 tables:
// 1) users
// 2) subcategories
// 3) posts
// 4) comments
// 
// Minimal schemas (for reference):
//   users (id SERIAL, username VARCHAR, created_at TIMESTAMP, ...)
//   subcategories (id SERIAL, name VARCHAR, description TEXT, ...)
//   posts (id SERIAL, title, content, author_id, subcategory_id, upvotes, downvotes, created_at, ...)
//   comments (id SERIAL, post_id, author_id, text, created_at, ...)
//
// If you have different column names, adapt the queries below accordingly.

/*************************************************************
 *  SUBCATEGORIES (CRUD)
 *************************************************************/
// GET all subcategories
app.get('/api/community/subcategories', async (req, res) => {
  try {
    const result = await client.query(
      'SELECT * FROM subcategories ORDER BY created_at DESC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Error in GET /api/community/subcategories:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET a single subcategory by ID
app.get('/api/community/subcategories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = 'SELECT * FROM subcategories WHERE id = $1';
    const { rows } = await client.query(sql, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Subcategory not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error in GET /api/community/subcategories/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// CREATE a new subcategory
app.post('/api/community/subcategories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'name is required' });
    }
    const insertSql = `
      INSERT INTO subcategories (name, description)
      VALUES ($1, $2)
      RETURNING *;
    `;
    const values = [name, description || null];
    const result = await client.query(insertSql, values);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in POST /api/community/subcategories:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// UPDATE a subcategory
app.put('/api/community/subcategories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    // If you require name, check for it
    const updateSql = `
      UPDATE subcategories
      SET name = $1,
          description = $2
      WHERE id = $3
      RETURNING *;
    `;
    const values = [name, description, id];
    const result = await client.query(updateSql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Subcategory not found or no changes made' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in PUT /api/community/subcategories/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// DELETE a subcategory
app.delete('/api/community/subcategories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteSql = 'DELETE FROM subcategories WHERE id = $1 RETURNING *';
    const result = await client.query(deleteSql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Subcategory not found' });
    }
    return res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error in DELETE /api/community/subcategories/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/*************************************************************
 *  POSTS (CRUD + upvote/downvote)
 *************************************************************/

// GET all posts (optionally filter by subcategory ID)
app.get('/api/community/posts', async (req, res) => {
  try {
    const subcat = req.query.subcat; // e.g. ?subcat=5
    let sql = `SELECT p.*, u.username, s.name AS subcat_name
               FROM posts p
               JOIN users u ON p.author_id = u.id
               LEFT JOIN subcategories s ON p.subcategory_id = s.id
               ORDER BY p.created_at DESC`;
    let values = [];

    if (subcat) {
      sql = `SELECT p.*, u.username, s.name AS subcat_name
             FROM posts p
             JOIN users u ON p.author_id = u.id
             LEFT JOIN subcategories s ON p.subcategory_id = s.id
             WHERE p.subcategory_id = $1
             ORDER BY p.created_at DESC`;
      values = [subcat];
    }

    const result = await client.query(sql, values);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error in GET /api/community/posts:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET a single post by ID
app.get('/api/community/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `
      SELECT p.*,
             u.username AS author_name,
             s.name     AS subcat_name
      FROM posts p
      JOIN users u ON p.author_id = u.id
      LEFT JOIN subcategories s ON p.subcategory_id = s.id
      WHERE p.id = $1
    `;
    const { rows } = await client.query(sql, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error in GET /api/community/posts/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// CREATE a new post
app.post('/api/community/posts', async (req, res) => {
  try {
    const { title, content, author_id, subcategory_id } = req.body;
    if (!title || !content || !author_id) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const insertSql = `
      INSERT INTO posts (title, content, author_id, subcategory_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const values = [title, content, author_id, subcategory_id || null];
    const result = await client.query(insertSql, values);

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in POST /api/community/posts:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// UPDATE a post
app.put('/api/community/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, subcategory_id } = req.body;
    // If you require title/content, check for them
    const updateSql = `
      UPDATE posts
      SET title = $1,
          content = $2,
          subcategory_id = $3
      WHERE id = $4
      RETURNING *;
    `;
    const values = [title, content, subcategory_id || null, id];
    const result = await client.query(updateSql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found or no changes made' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in PUT /api/community/posts/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE a post
app.delete('/api/community/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteSql = 'DELETE FROM posts WHERE id = $1 RETURNING *';
    const result = await client.query(deleteSql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    return res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error in DELETE /api/community/posts/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// UPVOTE a post
app.post('/api/community/posts/:id/upvote', async (req, res) => {
  try {
    const { id } = req.params;
    const updateSql = `
      UPDATE posts
      SET upvotes = upvotes + 1
      WHERE id = $1
      RETURNING upvotes;
    `;
    const result = await client.query(updateSql, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    return res.json({ upvotes: result.rows[0].upvotes });
  } catch (err) {
    console.error('Error in POST /api/community/posts/:id/upvote:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// DOWNVOTE a post
app.post('/api/community/posts/:id/downvote', async (req, res) => {
  try {
    const { id } = req.params;
    const updateSql = `
      UPDATE posts
      SET downvotes = downvotes + 1
      WHERE id = $1
      RETURNING downvotes;
    `;
    const result = await client.query(updateSql, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    return res.json({ downvotes: result.rows[0].downvotes });
  } catch (err) {
    console.error('Error in POST /api/community/posts/:id/downvote:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/*************************************************************
 *  COMMENTS (CRUD)
 *************************************************************/
// GET comments (optionally filter by postId)
app.get('/api/community/comments', async (req, res) => {
  try {
    const { postId } = req.query;
    let sql = `
      SELECT c.*,
             u.username AS author_name,
             p.title    AS post_title
      FROM comments c
      JOIN users u ON c.author_id = u.id
      JOIN posts p ON c.post_id = p.id
      ORDER BY c.created_at ASC
    `;
    let values = [];

    if (postId) {
      sql = `
        SELECT c.*,
               u.username AS author_name,
               p.title    AS post_title
        FROM comments c
        JOIN users u ON c.author_id = u.id
        JOIN posts p ON c.post_id = p.id
        WHERE c.post_id = $1
        ORDER BY c.created_at ASC
      `;
      values = [postId];
    }

    const result = await client.query(sql, values);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error in GET /api/community/comments:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// CREATE a comment
app.post('/api/community/comments', async (req, res) => {
  try {
    const { post_id, author_id, text } = req.body;
    if (!post_id || !author_id || !text) {
      return res.status(400).json({ message: 'Missing required fields (post_id, author_id, text)' });
    }

    const insertSql = `
      INSERT INTO comments (post_id, author_id, text)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const values = [post_id, author_id, text];
    const result = await client.query(insertSql, values);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in POST /api/community/comments:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// UPDATE a comment
app.put('/api/community/comments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ message: 'Missing text field' });
    }

    const updateSql = `
      UPDATE comments
      SET text = $1
      WHERE id = $2
      RETURNING *;
    `;
    const values = [text, id];
    const result = await client.query(updateSql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found or no changes made' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in PUT /api/community/comments/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE a comment
app.delete('/api/community/comments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteSql = 'DELETE FROM comments WHERE id = $1 RETURNING *';
    const result = await client.query(deleteSql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    return res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error in DELETE /api/community/comments/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/****************************************************
 *  Authorization routes
 ****************************************************/

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).send("Missing username or password");
    }

    // Hash the password
    const saltRounds = 10; // or your config
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Insert into users table
    const insertSql = `
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, $3)
      RETURNING id, username, role
    `;
    const values = [username, password_hash, role || 'user'];

    const result = await client.query(insertSql, values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).send("Internal server error");
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send("Missing username or password");
    }

    // Find user by username
    const userSql = `SELECT * FROM users WHERE username = $1`;
    const userRes = await client.query(userSql, [username]);
    if (userRes.rows.length === 0) {
      return res.status(400).send("Invalid credentials");
    }
    const user = userRes.rows[0];

    // Compare hashed passwords
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).send("Invalid credentials");
    }

    // Generate JWT or set session cookie
    // Example with JWT:
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      "YOUR_JWT_SECRET",
      { expiresIn: "1d" }
    );
    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Internal server error");
  }
});

// Example middleware to parse JWT from headers
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send("No token");
  const token = authHeader.split(' ')[1]; // "Bearer <token>"
  
  try {
    const decoded = jwt.verify(token, "YOUR_JWT_SECRET");
    req.user = decoded; // { userId, role, iat, exp }
    next();
  } catch(err) {
    return res.status(401).send("Invalid token");
  }
}

// Example route for DELETE /api/community/posts/:id
app.delete('/api/community/posts/:id', authMiddleware, async (req, res) => {
  // Check if role is "moderator" or "admin"
  if (req.user.role !== "moderator" && req.user.role !== "admin") {
    return res.status(403).send("Forbidden");
  }

  // Then proceed to delete the post
  const { id } = req.params;
  const deleteSql = 'DELETE FROM posts WHERE id = $1 RETURNING *';
  const result = await client.query(deleteSql, [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ message: 'Post not found' });
  }
  return res.json({ success: true, deleted: result.rows[0] });
});

app.post('/api/profile', authMiddleware, async (req, res) => {
  // authMiddleware ensures we have req.user.userId
  const userId = req.user.userId;
  const { fullName, avatar, location } = req.body;

  // Suppose we have columns in 'users' table for these:
  //   full_name, avatar_url, location
  // Or a separate 'profiles' table if you prefer a 1:1 relationship.

  const updateSql = `
    UPDATE users
    SET full_name = $1,
        avatar_url = $2,
        location = $3
    WHERE id = $4
    RETURNING id, username, full_name, avatar_url, location;
  `;
  const values = [fullName, avatar, location, userId];

  try {
    const result = await client.query(updateSql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/****************************************************
 *  FINALLY, START THE SERVER
 ****************************************************/
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});