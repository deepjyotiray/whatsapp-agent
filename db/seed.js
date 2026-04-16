const Database = require('better-sqlite3');
const db = new Database('./data/rays-home-kitchen.db');

db.exec(`
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mobile TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    order_date TEXT NOT NULL,
    order_time TEXT NOT NULL,
    order_for TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    notes TEXT,
    items TEXT NOT NULL,
    extras TEXT,
    total INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    email_sent INTEGER DEFAULT 0,
    email_error TEXT,
    customer_message TEXT,
    view_token TEXT,
    coupon_code TEXT,
    coupon_discount INTEGER DEFAULT 0,
    delivery_charge INTEGER DEFAULT 0,
    expected_delivery TEXT,
    expected_delivery_iso TEXT,
    location_url TEXT,
    location_lat REAL,
    location_lng REAL,
    location_accuracy REAL,
    delivery_distance_km REAL,
    payment_status TEXT,
    delivery_status TEXT,
    amount_paid INTEGER DEFAULT 0
);

CREATE TABLE menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    veg INTEGER NOT NULL,
    description TEXT,
    position INTEGER,
    available INTEGER DEFAULT 1,
    calories INTEGER,
    protein INTEGER,
    carbs INTEGER,
    fat INTEGER,
    image TEXT,
    served_with TEXT,
    customizations TEXT
);

CREATE TABLE menu_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_type TEXT NOT NULL,
    section_key TEXT NOT NULL,
    title TEXT NOT NULL,
    subheading TEXT,
    position INTEGER,
    available INTEGER DEFAULT 1,
    image TEXT
);

CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    item_name TEXT NOT NULL,
    total_deliveries INTEGER NOT NULL,
    deliveries_used INTEGER DEFAULT 0,
    order_id TEXT,
    start_date TEXT NOT NULL,
    expires_date TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscription_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    delivery_date TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount INTEGER NOT NULL,
    min_order INTEGER NOT NULL,
    free_delivery INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_percent INTEGER DEFAULT 0,
    max_discount INTEGER,
    free_delivery_only INTEGER DEFAULT 0
);

CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT NOT NULL,
    expense INTEGER DEFAULT 0,
    income INTEGER DEFAULT 0,
    heading TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_phone ON orders(phone);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_expenses_entry_date ON expenses(entry_date);
CREATE INDEX idx_expenses_created_at ON expenses(created_at);
`);

const insertUser = db.prepare('INSERT INTO users (name, mobile) VALUES (?, ?)');
insertUser.run('Aneesh Denny', '+919003796691');
insertUser.run('Anubhav Chauhan', '+919049700278');
insertUser.run('Harshit Gandhi', '+919819285183');
insertUser.run('Mayuri Rasal', '+918082040103');
insertUser.run('Shreya Langi', '+919158256769');

const insertOrder = db.prepare('INSERT INTO orders (id, order_date, order_time, order_for, customer_name, phone, address, items, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
insertOrder.run('RAY-1768453280372', '2026-01-15', '14:00:00', '2026-01-15', 'Mayuri Rasal', '+918082040103', 'Ananta Tower Building 19 1204', 'Prawns Masala + 3 Chapati/Rice bowl × 1 (Rs. 100)', 100, 'Paid');
insertOrder.run('Manual', '2026-01-15', '14:00:00', '2026-01-15', 'Aneesh Denny', '+919003796691', 'Ananta Tower Building 19 1302', 'Chicken Korma + 3 Chapati', 110, 'Paid');
insertOrder.run('260116_01', '2026-01-16', '14:00:00', '2026-01-16', 'Mayuri Rasal', '+918082040103', 'Ananta Tower Building 19 1204', 'Chicken Pulao x 1 (Rs.110)', 110, 'Paid');

const insertMenuItem = db.prepare('INSERT INTO menu_items (section_id, name, price, veg, description) VALUES (?, ?, ?, ?, ?)');
insertMenuItem.run(744, 'Steamed or Sauteed Chicken with Brown Rice, Broccoli and Veggies', 385, 0, 'Lean chicken served with brown rice, broccoli, and fresh veggies – clean, balanced, and filling.');
insertMenuItem.run(744, 'Sprouts and Mushroom with Capsicum and Veggies', 275, 1, 'Protein-rich sprouts and mushrooms tossed with crunchy veggies for a light yet powerful meal.');
insertMenuItem.run(744, 'Paneer with Brown Rice and Veggies', 385, 1, 'Soft paneer paired with wholesome brown rice and seasonal veggies.');

const insertMenuSection = db.prepare('INSERT INTO menu_sections (menu_type, section_key, title) VALUES (?, ?, ?)');
insertMenuSection.run('main', 'healthy', 'Healthy Salads');
insertMenuSection.run('main', 'healthySubs', '30 Healthy Salads');
insertMenuSection.run('motd', 'motd', 'Today\'s Specials !');

const insertSubscription = db.prepare('INSERT INTO subscriptions (customer_name, phone, address, item_name, total_deliveries, start_date, expires_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
insertSubscription.run('Aneesh Denny', '+919003796691', 'Ananta Tower Building 19 1302', 'Chicken Salad Meal', 30, '2026-03-11', '2026-04-25', 'Active');
insertSubscription.run('Aneesh Denny', '+919003796691', 'Ananta Tower Building 19 1302', 'Paneer Salad Meal', 30, '2026-03-11', '2026-04-25', 'Active');

const insertSubscriptionDelivery = db.prepare('INSERT INTO subscription_deliveries (subscription_id, delivery_date) VALUES (?, ?)');
insertSubscriptionDelivery.run(1, '2026-03-13');
insertSubscriptionDelivery.run(2, '2026-03-14');
insertSubscriptionDelivery.run(1, '2026-03-16');

const insertCoupon = db.prepare('INSERT INTO coupons (code, discount, min_order) VALUES (?, ?, ?)');
insertCoupon.run('FLAT30', 30, 300);
insertCoupon.run('FLAT50', 50, 500);
insertCoupon.run('SPECIALONES', 0, 600);

module.exports = db;
