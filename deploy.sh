#!/bin/bash

echo "🚀 Deploying Telegram Stream Bot to Koyeb..."

# Build and push to registry (if using custom registry)
# docker build -t your-registry/telegram-stream-bot .
# docker push your-registry/telegram-stream-bot

# Deploy using Koyeb CLI
koyeb service create telegram-stream-bot \
  --app telegram-stream-bot \
  --dockerfile Dockerfile \
  --ports 8000:http \
  --routes /:8000 \
  --env BOT_TOKEN="$BOT_TOKEN" \
  --env MONGO_URI="$MONGO_URI" \
  --instance-type nano

echo "✅ Deployment completed!"
