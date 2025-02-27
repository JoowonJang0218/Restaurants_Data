const express = require('express');
const axios = require('axios');
const { Client } = require('pg');
const cors = require('cors');

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
  const { store_name, address } = req.body;
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

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});