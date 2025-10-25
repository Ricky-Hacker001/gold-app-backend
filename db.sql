CREATE DATABASE IF NOT EXISTS gold_app;

USE gold_app;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

USE gold_app;

-- This table will store your app's settings, including the gold price.
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(50) PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Insert a starting price so the app doesn't break
INSERT INTO app_settings (setting_key, setting_value)
VALUES ('current_gold_price', '6850.00')
ON DUPLICATE KEY UPDATE setting_key = 'current_gold_price';
USE gold_app;

CREATE TABLE IF NOT EXISTS price_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  price_date DATE NOT NULL UNIQUE,
  price_value DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO price_history (price_date, price_value)
VALUES
  ('2025-10-18', 6810.50),
  ('2025-10-19', 6835.10),
  ('2025-10-20', 6820.00),
  ('2025-10-21', 6855.75),
  ('2025-10-22', 6840.20),
  ('2025-10-23', 6870.00),
  ('2025-10-24', 6850.00)
ON DUPLICATE KEY UPDATE price_date=VALUES(price_date);

USE gold_app;

-- 1. Create a table for all transactions (purchases and withdrawals)
CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type ENUM('buy', 'withdraw') NOT NULL,
    status ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    amount_inr DECIMAL(10, 2) NOT NULL,
    grams DECIMAL(10, 4) NOT NULL,
    price_per_gram DECIMAL(10, 2) NOT NULL,
    payment_id VARCHAR(255), -- For Cashfree's ID later
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 2. Create a table for each user's total gold balance
CREATE TABLE IF NOT EXISTS portfolio (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    total_grams DECIMAL(10, 4) NOT NULL DEFAULT 0.0000,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

USE gold_app;
ALTER TABLE transactions
ADD COLUMN cashfree_order_id VARCHAR(255) NULL AFTER payment_id;