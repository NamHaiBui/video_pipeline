#!/bin/bash

# Podcast Pipeline Testing Script
# Quick reference for testing the refactored podcast pipeline

echo "🎙️ Podcast Processing Pipeline - Test Runner"
echo "============================================"

# Check if LocalStack is running
if ! docker ps | grep -q localstack; then
    echo "❌ LocalStack is not running. Starting LocalStack..."
    docker-compose -f localstack/docker-compose.yml up -d
    echo "⏳ Waiting for LocalStack to start..."
    sleep 10
fi

echo "✅ LocalStack is running"

# Set LocalStack environment
export LOCALSTACK=true
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_REGION=us-east-1

echo ""
echo "🔧 Building project..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build successful"
echo ""

# Test options
echo "Select test to run:"
echo "1. Complete Podcast Pipeline Test"
echo "2. Podcast Conversion Test"
echo "3. LocalStack Integration Test"
echo "4. All Tests"
echo ""

read -p "Enter choice (1-4): " choice

case $choice in
    1)
        echo "🧪 Running Complete Podcast Pipeline Test..."
        npm run test:podcast-pipeline
        ;;
    2)
        echo "🧪 Running Podcast Conversion Test..."
        npx tsx src/scripts/test-podcast-conversion.ts
        ;;
    3)
        echo "🧪 Running LocalStack Integration Test..."
        npx tsx src/scripts/test-localstack-integration.ts
        ;;
    4)
        echo "🧪 Running All Tests..."
        echo ""
        echo "--- Complete Pipeline Test ---"
        npm run test:podcast-pipeline
        echo ""
        echo "--- Conversion Test ---"
        npx tsx src/scripts/test-podcast-conversion.ts
        echo ""
        echo "--- LocalStack Integration Test ---"
        npx tsx src/scripts/test-localstack-integration.ts
        ;;
    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "🎉 Testing completed!"
echo ""
echo "💡 Quick Commands:"
echo "   - Build: npm run build"
echo "   - Full Test: npm run test:podcast-pipeline"
echo "   - Conversion Test: LOCALSTACK=true AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test npx tsx src/scripts/test-podcast-conversion.ts"
echo "   - Check LocalStack: docker ps | grep localstack"
echo "   - View logs: docker logs localstack-main"
