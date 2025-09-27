// server/seedLmo.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const seedLmo = async () => {
  const lmoData = {
    fullName: 'Officer Priya Sharma',
    employeeId: 'LMO12345',
    password: 'password123', // Simple password for testing
    taluk: 'Coimbatore South'
  };

  try {
    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(lmoData.password, salt);

    // Insert into the database
    await pool.query(
      'INSERT INTO lmos (full_name, employee_id, password_hash, taluk) VALUES ($1, $2, $3, $4)',
      [lmoData.fullName, lmoData.employeeId, passwordHash, lmoData.taluk]
    );

    console.log('✅ LMO user seeded successfully!');
  } catch (err) {
    console.error('Error seeding LMO:', err.message);
  } finally {
    await pool.end();
  }
};

seedLmo();