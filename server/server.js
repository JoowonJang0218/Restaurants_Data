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

app.put('/api/users/:id/role', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;         // The user we want to modify
    const { role: newRole } = req.body; // e.g. { "role": "moderator" }

    // 1) Make sure newRole is valid
    const allowedRoles = ['user', 'moderator', 'admin'];
    if (!allowedRoles.includes(newRole)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    // 2) Find the target user so we can see their current role
    const findUserSql = 'SELECT id, username, role FROM users WHERE id = $1';
    const findRes = await client.query(findUserSql, [id]);
    if (findRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    const targetUser = findRes.rows[0];

    // 3) Check the role of the logged-in user (req.user.role)
    const actingRole = req.user.role; // 'user', 'moderator', or 'admin'
    if (actingRole === 'admin') {
      // Admin can set any role for anyone
      // No further checks needed
    } else if (actingRole === 'moderator') {
      // Moderator can only promote someone to 'moderator'
      // (And only if the target is not already an admin.)
      if (newRole !== 'moderator') {
        return res.status(403).json({ message: "Forbidden: moderator can only set role=moderator" });
      }
      // If the target user is an admin, we definitely shouldn’t demote them
      if (targetUser.role === 'admin') {
        return res.status(403).json({ message: "Forbidden: cannot modify an admin's role" });
      }
      // Otherwise, user -> moderator is allowed
    } else {
      // A normal user can't change roles at all
      return res.status(403).json({ message: "Forbidden: you do not have permission to change roles" });
    }

    // 4) Perform the update
    const updateSql = `
      UPDATE users
      SET role = $2
      WHERE id = $1
      RETURNING id, username, role
    `;
    const updateRes = await client.query(updateSql, [id, newRole]);
    const updatedUser = updateRes.rows[0];

    res.json({ success: true, updatedUser });
  } catch (err) {
    console.error("Error changing user role:", err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/users/:id/promoteToModerator', authMiddleware, async (req, res) => {
  try {
    // 1) Only admin or moderator can do this
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Forbidden: only mods or admins' });
    }

    const { id } = req.params;

    // 2) Check if the target user exists & is not an admin
    const findUserSql = 'SELECT id, username, role FROM users WHERE id = $1';
    const findRes = await client.query(findUserSql, [id]);
    if (findRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    const targetUser = findRes.rows[0];
    if (targetUser.role === 'admin') {
      return res.status(403).json({ message: 'Cannot promote an admin to moderator' });
    }

    // 3) Update the user’s role to "moderator"
    const updateSql = `
      UPDATE users
      SET role = 'moderator'
      WHERE id = $1
      RETURNING id, username, role
    `;
    const updateRes = await client.query(updateSql, [id]);
    const updatedUser = updateRes.rows[0];

    res.json({ success: true, updatedUser });
  } catch (err) {
    console.error("Error promoting to moderator:", err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1) Confirm the acting user is admin or moderator
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Forbidden: only admin or moderator can delete users' });
    }

    // 2) Fetch the target user
    const findUserSql = 'SELECT id, username, role FROM users WHERE id = $1';
    const findRes = await client.query(findUserSql, [id]);
    if (findRes.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    const targetUser = findRes.rows[0];

    // (Optional) If you want to prevent a moderator from deleting an admin, do so here:
    if (req.user.role === 'moderator' && targetUser.role === 'admin') {
      return res.status(403).json({ message: 'Forbidden: cannot delete an admin as a moderator' });
    }

    // 3) "Soft delete": Overwrite username, password_hash, role
    const updateSql = `
      UPDATE users
      SET username       = '[DELETED USER]',
          password_hash  = NULL,
          role           = 'deleted'
      WHERE id = $1
      RETURNING id, username, role
    `;
    const updateRes = await client.query(updateSql, [id]);
    const updatedUser = updateRes.rows[0];

    // (Optional) If you actually want to physically delete them, do so after the update:
    // But that would break the references in posts/comments unless you handle that carefully.

    res.json({ success: true, user: updatedUser });
  } catch (err) {
    console.error('Error in DELETE /api/users/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});
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

app.get('/api/community/trending', async (req, res) => {
  try {
    const sql = `
      SELECT
        p.id,
        p.title,
        p.upvotes,
        p.downvotes,
        s.name AS subcat_name,
        (
          (p.upvotes + 1)::float / (p.downvotes + 1)::float
        ) AS ratio
      FROM posts p
      LEFT JOIN subcategories s ON p.subcategory_id = s.id
      WHERE p.created_at >= date_trunc('day', now())  -- "today" only
      ORDER BY ratio DESC
      LIMIT 2
    `;
    const { rows } = await client.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Error in GET /api/community/trending:", err);
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
app.post('/api/community/posts', authMiddleware, async (req, res) => {
  try {
    const { title, content, subcategory_id } = req.body;
    // 1) Check if this user is visibleToOthers
    const userResult = await client.query(
      'SELECT visible_to_others FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (userResult.rows[0].visible_to_others === false) {
      return res.status(403).json({ message: 'You must be visible to others to create posts' });
    }

    // 2) Now proceed with post creation
    if (!title || !content) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const insertSql = `
      INSERT INTO posts (title, content, author_id, subcategory_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const values = [title, content, req.user.userId, subcategory_id || null];
    const result = await client.query(insertSql, values);

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in POST /api/community/posts:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// UPDATE a post
app.put('/api/community/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, subcategory_id } = req.body;

    // 1) Find the post to see who the author is
    const checkSql = 'SELECT author_id FROM posts WHERE id = $1';
    const checkRes = await client.query(checkSql, [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const post = checkRes.rows[0];

    // 2) Compare author_id with the current user, or check if role is moderator/admin
    const isAuthor = (post.author_id === req.user.userId);
    const isModOrAdmin = (req.user.role === 'moderator' || req.user.role === 'admin');

    if (!isAuthor && !isModOrAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // 3) If authorized, perform the update
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
app.delete('/api/community/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1) Find the post
    const checkSql = 'SELECT author_id FROM posts WHERE id = $1';
    const checkRes = await client.query(checkSql, [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const post = checkRes.rows[0];

    // 2) Check if the user is the author OR a moderator/admin
    const isAuthor = (post.author_id === req.user.userId);
    const isModOrAdmin = (req.user.role === 'moderator' || req.user.role === 'admin');

    if (!isAuthor && !isModOrAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // 3) Delete the post
    const deleteSql = 'DELETE FROM posts WHERE id = $1 RETURNING *';
    const result = await client.query(deleteSql, [id]);

    return res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error in DELETE /api/community/posts/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// UPVOTE a post
// POST /api/community/posts/:id/upvote
app.post('/api/community/posts/:id/upvote', authMiddleware, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    const userId = req.user.userId; // from the token
    if (!postId) {
      return res.status(400).json({ message: 'Invalid post ID' });
    }

    // 1) Check if the post exists
    const postCheck = await client.query('SELECT id, upvotes, downvotes FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const post = postCheck.rows[0];

    // 2) Check if there's already a vote row in "post_votes"
    const voteCheck = await client.query(
      'SELECT vote_type FROM post_votes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    if (voteCheck.rows.length === 0) {
      // No prior vote => Insert new row (+1)
      await client.query('BEGIN'); // start transaction

      await client.query(
        'INSERT INTO post_votes (user_id, post_id, vote_type) VALUES ($1, $2, $3)',
        [userId, postId, +1]
      );

      // increment the "upvotes" in posts
      const newUpvotes = post.upvotes + 1;
      await client.query(
        'UPDATE posts SET upvotes = $1 WHERE id = $2',
        [newUpvotes, postId]
      );

      await client.query('COMMIT');

      return res.json({ success: true, upvotes: newUpvotes, message: 'Upvoted!' });

    } else {
      // There's an existing vote row
      const existingVote = voteCheck.rows[0].vote_type; // +1 or -1

      if (existingVote === +1) {
        // They already upvoted => do nothing or allow un-vote logic
        return res.json({ success: false, message: 'Already upvoted this post.' });
      } else {
        // They had a -1 (downvote) and want to upvote now => switch
        // So we remove 1 from downvotes, add 1 to upvotes
        await client.query('BEGIN');

        await client.query(
          'UPDATE post_votes SET vote_type = $1 WHERE user_id = $2 AND post_id = $3',
          [+1, userId, postId]
        );

        // decrement post.downvotes, increment post.upvotes
        const newUpvotes = post.upvotes + 1;
        const newDownvotes = post.downvotes - 1;
        await client.query(
          'UPDATE posts SET upvotes = $1, downvotes = $2 WHERE id = $3',
          [newUpvotes, newDownvotes, postId]
        );

        await client.query('COMMIT');

        return res.json({ success: true, upvotes: newUpvotes, downvotes: newDownvotes, message: 'Changed vote to upvote.' });
      }
    }

  } catch (err) {
    console.error("Error in upvote route:", err);
    await client.query('ROLLBACK').catch(() => {}); // in case transaction was started
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// DOWNVOTE a post
app.post('/api/community/posts/:id/downvote', authMiddleware, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    const userId = req.user.userId; // from the token
    if (!postId) {
      return res.status(400).json({ message: 'Invalid post ID' });
    }

    // 1) Check if the post exists
    const postCheck = await client.query('SELECT id, upvotes, downvotes FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const post = postCheck.rows[0];

    // 2) Check if there's already a vote row in "post_votes"
    const voteCheck = await client.query(
      'SELECT vote_type FROM post_votes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    if (voteCheck.rows.length === 0) {
      // No prior vote => Insert new row (-1)
      await client.query('BEGIN');

      await client.query(
        'INSERT INTO post_votes (user_id, post_id, vote_type) VALUES ($1, $2, $3)',
        [userId, postId, -1]
      );

      // increment the "downvotes" in posts
      const newDownvotes = post.downvotes + 1;
      await client.query(
        'UPDATE posts SET downvotes = $1 WHERE id = $2',
        [newDownvotes, postId]
      );

      await client.query('COMMIT');

      return res.json({ success: true, downvotes: newDownvotes, message: 'Downvoted!' });

    } else {
      // There's an existing vote row
      const existingVote = voteCheck.rows[0].vote_type; // +1 or -1

      if (existingVote === -1) {
        // Already downvoted => do nothing (or you could remove the vote)
        return res.json({ success: false, message: 'Already downvoted this post.' });
      } else {
        // They had a +1 (upvote) and want to downvote now => switch
        // So we remove 1 from upvotes, add 1 to downvotes
        await client.query('BEGIN');

        await client.query(
          'UPDATE post_votes SET vote_type = $1 WHERE user_id = $2 AND post_id = $3',
          [-1, userId, postId]
        );

        const newUpvotes = post.upvotes - 1;
        const newDownvotes = post.downvotes + 1;
        await client.query(
          'UPDATE posts SET upvotes = $1, downvotes = $2 WHERE id = $3',
          [newUpvotes, newDownvotes, postId]
        );

        await client.query('COMMIT');

        return res.json({
          success: true,
          upvotes: newUpvotes,
          downvotes: newDownvotes,
          message: 'Changed vote to downvote.'
        });
      }
    }

  } catch (err) {
    console.error("Error in downvote route:", err);
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ message: 'Internal server error' });
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
// ONLY the author can edit their own comment; no moderator/admin override
app.put('/api/community/comments/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ message: 'Missing text field' });
    }

    // 1) Find the comment to see who the author is
    const checkSql = 'SELECT author_id FROM comments WHERE id = $1';
    const checkRes = await client.query(checkSql, [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    const comment = checkRes.rows[0];

    // 2) The only person who can edit is the comment's author
    const isAuthor = (comment.author_id === req.user.userId);
    if (!isAuthor) {
      return res.status(403).json({ message: 'Forbidden: only the author can edit' });
    }

    // 3) Proceed with the update
    const updateSql = `
      UPDATE comments
      SET text = $1
      WHERE id = $2
      RETURNING *;
    `;
    const values = [text, id];
    const result = await client.query(updateSql, values);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in PUT /api/community/comments/:id:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// DELETE a comment
// The author OR a moderator/admin can delete the comment
app.delete('/api/community/comments/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1) Find the comment
    const checkSql = 'SELECT author_id FROM comments WHERE id = $1';
    const checkRes = await client.query(checkSql, [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    const comment = checkRes.rows[0];

    // 2) The comment’s author OR mod/admin can delete
    const isAuthor = (comment.author_id === req.user.userId);
    const isModOrAdmin = (req.user.role === 'moderator' || req.user.role === 'admin');

    if (!isAuthor && !isModOrAdmin) {
      return res.status(403).json({ message: 'Forbidden: only author or mod/admin can delete' });
    }

    // 3) Delete the comment
    const deleteSql = 'DELETE FROM comments WHERE id = $1 RETURNING *';
    const result = await client.query(deleteSql, [id]);
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
// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).send("Missing username or password");
    }

    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Insert user
    const insertSql = `
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, $3)
      RETURNING id, username, role
    `;
    const values = [username, password_hash, role || 'user'];
    const result = await client.query(insertSql, values);
    const user = result.rows[0]; // { id, username, role }

    // Immediately sign a token so they don't need to re-login
    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username, // <-- Include username
        role: user.role
      },
      "YOUR_JWT_SECRET",
      { expiresIn: "1d" }
    );

    // Return { token, user } or just token if you like
    res.json({ token, user });
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
      {
        userId: user.id,
        username: user.username,
        role: user.role
      },
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

/*
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
});*/

// app.post('/api/profile', authMiddleware, async (req, res) => {
  app.post('/api/profile', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    const {
      firstName,
      lastName,
      gender,
      nationalities,
      ethnicities,
      birthday,
      countryHome,
      countryGrewUpIn,
      bio,
      visibleToOthers
    } = req.body;
  
    // Validate or sanitize if needed (e.g. ensure arrays have <= 3 items, etc.)
    // e.g. nationalities = nationalities.slice(0, 3);
  
    const updateSql = `
      UPDATE users
      SET
        first_name        = $1,
        last_name         = $2,
        gender            = $3,
        nationalities     = $4,
        ethnicities       = $5,
        birthday          = $6,
        country_home      = $7,
        country_grew_up_in= $8,
        bio               = $9,
        visible_to_others = $10
      WHERE id = $11
      RETURNING
        id,
        username,
        first_name,
        last_name,
        gender,
        nationalities,
        ethnicities,
        birthday,
        country_home,
        country_grew_up_in,
        bio,
        visible_to_others
    `;
    const values = [
      firstName || null,
      lastName || null,
      gender || null,
      Array.isArray(nationalities) ? nationalities : [],
      Array.isArray(ethnicities) ? ethnicities : [],
      birthday || null,
      countryHome || null,
      countryGrewUpIn || null,
      bio || null,
      typeof visibleToOthers === 'boolean' ? visibleToOthers : true,
      userId
    ];
  
    try {
      const result = await client.query(updateSql, values);
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json(result.rows[0]); // Return the updated user
    } catch (err) {
      console.error("Profile error:", err);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

// DELETE /api/users/:id
// For example, only admins can delete users — so you might add authMiddleware + a role check
/*
app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    // Optionally check if this user is an admin or the user being deleted
    if (req.user.role !== "admin") {
      return res.status(403).send("Forbidden");
    }

    const { id } = req.params;

    const deleteSql = 'DELETE FROM users WHERE id = $1 RETURNING id, username';
    const result = await client.query(deleteSql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found or already deleted' });
    }

    return res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});*/

/****************************************************
 *  FINALLY, START THE SERVER
 ****************************************************/
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});