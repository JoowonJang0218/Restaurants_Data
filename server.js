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
  user: 'postgres',
  host: 'localhost',
  database: 'WhyCookIn_RestaurantDB',
  password: '020218',
  port: 5432
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

// 5) Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});