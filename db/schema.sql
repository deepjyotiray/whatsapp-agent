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
