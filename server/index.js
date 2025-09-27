// --- Dependencies ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./middleware/authMiddleware');
const lmoAuthMiddleware = require('./middleware/lmoAuthMiddleware');


// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 5000;

// --- Middleware ---
app.use(cors()); 
app.use(express.json()); 

// --- PostgreSQL Connection Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- Auth Routes ---
app.post('/api/auth/register', async (req, res) => {
  // ... (code is unchanged)
  const { business_name, owner_name, mobile_number, password, taluk, address } = req.body;
  if (!business_name || !owner_name || !mobile_number || !password || !taluk) {
    return res.status(400).json({ msg: 'Please enter all required fields.' });
  }
  try {
    const userExists = await pool.query('SELECT * FROM traders WHERE mobile_number = $1', [mobile_number]);
    if (userExists.rows.length > 0) {
      return res.status(409).json({ msg: 'A trader with this mobile number already exists.' });
    }
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const newTrader = await pool.query(
      'INSERT INTO traders (business_name, owner_name, mobile_number, password_hash, taluk, address) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, business_name, mobile_number, taluk',
      [business_name, owner_name, mobile_number, password_hash, taluk, address]
    );
    res.status(201).json({
      msg: 'Trader registered successfully! ✅',
      trader: newTrader.rows[0],
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.post('/api/auth/login', async (req, res) => {
  // ... (code is unchanged)
  const { mobile_number, password } = req.body;
  if (!mobile_number || !password) {
    return res.status(400).json({ msg: 'Please provide both mobile number and password.' });
  }
  try {
    const traderResult = await pool.query('SELECT * FROM traders WHERE mobile_number = $1', [mobile_number]);
    if (traderResult.rows.length === 0) {
      return res.status(400).json({ msg: 'Invalid credentials.' });
    }
    const trader = traderResult.rows[0];
    const isMatch = await bcrypt.compare(password, trader.password_hash);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Invalid credentials.' });
    }
    const payload = { trader: { id: trader.id } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: 3600 }, (err, token) => {
      if (err) throw err;
      res.status(200).json({ token });
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// --- Appointment Routes ---
app.get('/api/appointments/slots', authMiddleware, async (req, res) => {
  const { date } = req.query; 

  if (!date) {
    return res.status(400).json({ msg: 'A date parameter is required.' });
  }

  try {
    const allPossibleSlots = [
      { id: 1, time: '09:00 AM - 10:00 AM' },
      { id: 2, time: '10:00 AM - 11:00 AM' },
      { id: 3, time: '11:00 AM - 12:00 PM' },
      { id: 4, time: '02:00 PM - 03:00 PM' },
      { id: 5, time: '03:00 PM - 04:00 PM' },
    ];
    const bookingsResult = await pool.query("SELECT slot_time FROM bookings WHERE slot_date = $1", [date]);
    
    const bookedTimes = bookingsResult.rows.map(row => row.slot_time);
    const availableSlots = allPossibleSlots.filter(slot => !bookedTimes.includes(slot.time));
    
    res.json(availableSlots);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.post('/api/appointments/book', authMiddleware, async (req, res) => {
  const { slotTime, slotDate } = req.body;
  const traderId = req.trader.id;

  if (!slotTime || !slotDate) {
    return res.status(400).json({ msg: 'Slot time and date are required.' });
  }
  try {
    const newBooking = await pool.query(
      'INSERT INTO bookings (trader_id, slot_date, slot_time) VALUES ($1, $2, $3) RETURNING id',
      [traderId, slotDate, slotTime]
    );

    // --- MODIFIED: Add notification on booking ---
    const notificationMessage = `Your appointment for ${slotDate} at ${slotTime} has been successfully booked.`;
    await pool.query(
      'INSERT INTO notifications (trader_id, message) VALUES ($1, $2)',
      [traderId, notificationMessage]
    );

    res.status(201).json({ 
      msg: `Appointment booked successfully for ${slotDate} at ${slotTime}!`,
      bookingId: newBooking.rows[0].id
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ msg: 'This time slot is no longer available. Please select another.' });
    }
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.get('/api/appointments/my-history', authMiddleware, async (req, res) => {
    try {
        const history = await pool.query(
            'SELECT * FROM bookings WHERE trader_id = $1 ORDER BY slot_date DESC, slot_time DESC',
            [req.trader.id]
        );
        res.json(history.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/certificate/:bookingId', authMiddleware, async (req, res) => {
    try {
        const { bookingId } = req.params;
        const traderId = req.trader.id;

        const query = `
            SELECT b.id, b.slot_date, b.status, t.business_name, t.taluk
            FROM bookings b
            JOIN traders t ON b.trader_id = t.id
            WHERE b.id = $1 AND b.trader_id = $2
        `;

        const result = await pool.query(query, [bookingId, traderId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ msg: 'Certificate not found or you do not have permission to view it.' });
        }

        const booking = result.rows[0];

        if (booking.status !== 'Verified') {
            return res.status(403).json({ msg: 'This appointment has not been verified yet.' });
        }

        const certificateData = {
            certificateId: `LMC-2025-${booking.id}`,
            businessName: booking.business_name,
            taluk: booking.taluk,
            verificationDate: booking.slot_date,
            validUntil: new Date(new Date(booking.slot_date).setFullYear(new Date(booking.slot_date).getFullYear() + 1)).toISOString().split('T')[0],
            status: 'VERIFIED & CERTIFIED'
        };

        res.json(certificateData);

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// --- LMO Routes ---
app.post('/api/lmo/auth/login', async (req, res) => {
  const { employeeId, password } = req.body;
  if (!employeeId || !password) {
    return res.status(400).json({ msg: 'Please provide both Employee ID and password.' });
  }

  try {
    const lmoResult = await pool.query('SELECT * FROM lmos WHERE employee_id = $1', [employeeId]);
    if (lmoResult.rows.length === 0) {
      return res.status(400).json({ msg: 'Invalid credentials.' });
    }
    const lmo = lmoResult.rows[0];
    const isMatch = await bcrypt.compare(password, lmo.password_hash);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Invalid credentials.' });
    }
    
    const payload = { lmo: { id: lmo.id } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: 3600 }, (err, token) => {
      if (err) throw err;
      res.status(200).json({ token });
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.get('/api/lmo/appointments', lmoAuthMiddleware, async (req, res) => {
    const { date } = req.query; 

    if (!date) {
        return res.status(400).json({ msg: 'A date parameter is required.' });
    }

    try {
        const query = `
            SELECT 
                b.id as booking_id, b.slot_date, b.slot_time, b.status,
                t.business_name, t.owner_name, t.mobile_number
            FROM bookings b
            JOIN traders t ON b.trader_id = t.id
            WHERE b.slot_date = $1
            ORDER BY b.slot_time;
        `;
        const appointmentsResult = await pool.query(query, [date]);
        res.json(appointmentsResult.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/lmo/appointments/:id', lmoAuthMiddleware, async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  const allowedStatus = ['Verified', 'Rejected', 'Pending'];
  if (!status || !allowedStatus.includes(status)) {
    return res.status(400).json({ msg: 'A valid status is required.' });
  }

  try {
    const updateQuery = 'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *';
    const updatedBooking = await pool.query(updateQuery, [status, id]);

    if (updatedBooking.rows.length === 0) {
      return res.status(404).json({ msg: 'Booking not found.' });
    }
    
    // --- MODIFIED: Add notification on status update ---
    const { trader_id, slot_date, slot_time } = updatedBooking.rows[0];
    const notificationMessage = `The status of your appointment on ${new Date(slot_date).toLocaleDateString()} at ${slot_time} has been updated to: ${status}.`;
    await pool.query(
      'INSERT INTO notifications (trader_id, message) VALUES ($1, $2)',
      [trader_id, notificationMessage]
    );

    res.json({
        msg: `Booking #${id} has been updated to ${status}.`,
        booking: updatedBooking.rows[0]
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// --- NEW: Notification Routes ---
app.get('/api/notifications', authMiddleware, async (req, res) => {
    try {
        const notifications = await pool.query(
            'SELECT * FROM notifications WHERE trader_id = $1 ORDER BY created_at DESC',
            [req.trader.id]
        );
        res.json(notifications.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.post('/api/notifications/mark-read', authMiddleware, async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE trader_id = $1',
            [req.trader.id]
        );
        res.status(200).json({ msg: 'Notifications marked as read.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// --- Server Listener ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});