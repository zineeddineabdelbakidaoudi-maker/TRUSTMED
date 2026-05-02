#!/bin/bash
set -e

echo "=== TrustMed Deploy ==="
git pull origin main
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d --build
sleep 5
node migrate.js
echo "=== Deploy complete ==="
docker-compose -f docker-compose.prod.yml ps
