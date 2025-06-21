#!/bin/bash

# Video Pipeline Container Validation Script
# Tests the containerized setup to ensure everything is working correctly

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TOTAL_TESTS=0

# Helper functions
log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

test_start() {
    echo ""
    info "🧪 Testing: $1"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

test_pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

test_fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

# Test functions
test_docker_available() {
    test_start "Docker availability"
    if command -v docker &> /dev/null; then
        test_pass "Docker is installed and available"
    else
        test_fail "Docker is not installed or not in PATH"
        return 1
    fi
}

test_docker_compose_available() {
    test_start "Docker Compose availability"
    if command -v docker-compose &> /dev/null || docker compose version &> /dev/null; then
        test_pass "Docker Compose is available"
    else
        test_fail "Docker Compose is not available"
        return 1
    fi
}

test_dockerfile_syntax() {
    test_start "Dockerfile syntax validation"
    
    # Test main Dockerfile
    if docker build -f Dockerfile --target base -t test-base . &> /dev/null; then
        test_pass "Main Dockerfile syntax is valid"
    else
        test_fail "Main Dockerfile has syntax errors"
        return 1
    fi
    
    # Test production Dockerfile
    if docker build -f Dockerfile.production --target base -t test-base-prod . &> /dev/null; then
        test_pass "Production Dockerfile syntax is valid"
    else
        test_fail "Production Dockerfile has syntax errors"
        return 1
    fi
    
    # Clean up test images
    docker rmi test-base test-base-prod &> /dev/null || true
}

test_docker_compose_syntax() {
    test_start "Docker Compose file syntax validation"
    
    # Test main compose file
    if docker-compose -f docker-compose.yml config &> /dev/null; then
        test_pass "docker-compose.yml syntax is valid"
    else
        test_fail "docker-compose.yml has syntax errors"
        return 1
    fi
    
    # Test production compose file
    if docker-compose -f docker-compose.prod.yml config &> /dev/null; then
        test_pass "docker-compose.prod.yml syntax is valid"
    else
        test_fail "docker-compose.prod.yml has syntax errors"
        return 1
    fi
}

test_build_development_image() {
    test_start "Building development image"
    
    if docker build -f Dockerfile -t video-pipeline:dev-test --target development . &> /dev/null; then
        test_pass "Development image built successfully"
        # Clean up
        docker rmi video-pipeline:dev-test &> /dev/null || true
    else
        test_fail "Failed to build development image"
        return 1
    fi
}

test_build_production_image() {
    test_start "Building production image"
    
    if docker build -f Dockerfile.production -t video-pipeline:prod-test --target production . &> /dev/null; then
        test_pass "Production image built successfully"
        # Clean up
        docker rmi video-pipeline:prod-test &> /dev/null || true
    else
        test_fail "Failed to build production image"
        return 1
    fi
}

test_bgutil_provider_accessibility() {
    test_start "bgutil-ytdlp-pot-provider accessibility"
    
    # Try to pull the image
    if docker pull brainicism/bgutil-ytdlp-pot-provider:latest &> /dev/null; then
        test_pass "bgutil-ytdlp-pot-provider image is accessible"
    else
        test_fail "Cannot pull bgutil-ytdlp-pot-provider image"
        return 1
    fi
}

test_environment_files() {
    test_start "Environment configuration files"
    
    if [ -f ".env.example" ]; then
        test_pass ".env.example exists"
    else
        test_fail ".env.example is missing"
        return 1
    fi
    
    # Check for required environment variables in .env.example
    local required_vars=(
        "AWS_REGION"
        "S3_AUDIO_BUCKET_NAME"
        "S3_VIDEO_BUCKET_NAME"
        "DYNAMODB_PODCAST_EPISODES_TABLE"
    )
    
    for var in "${required_vars[@]}"; do
        if grep -q "$var" .env.example; then
            test_pass "$var is documented in .env.example"
        else
            test_fail "$var is missing from .env.example"
            return 1
        fi
    done
}

test_helper_scripts() {
    test_start "Helper scripts"
    
    if [ -f "docker-helper.sh" ] && [ -x "docker-helper.sh" ]; then
        test_pass "docker-helper.sh exists and is executable"
    else
        test_fail "docker-helper.sh is missing or not executable"
        return 1
    fi
    
    if [ -f "deploy-ecs.sh" ] && [ -x "deploy-ecs.sh" ]; then
        test_pass "deploy-ecs.sh exists and is executable"
    else
        test_fail "deploy-ecs.sh is missing or not executable"
        return 1
    fi
}

test_documentation() {
    test_start "Documentation files"
    
    if [ -f "CONTAINER_DEPLOYMENT.md" ]; then
        test_pass "CONTAINER_DEPLOYMENT.md exists"
    else
        test_fail "CONTAINER_DEPLOYMENT.md is missing"
        return 1
    fi
    
    if [ -f "README.md" ]; then
        test_pass "README.md exists"
    else
        test_fail "README.md is missing"
        return 1
    fi
}

test_essential_directories() {
    test_start "Essential directory structure"
    
    local required_dirs=(
        "src"
        "bin"
        "downloads"
        "temp"
    )
    
    for dir in "${required_dirs[@]}"; do
        if [ -d "$dir" ]; then
            test_pass "Directory $dir exists"
        else
            test_fail "Directory $dir is missing"
            return 1
        fi
    done
}

test_package_json() {
    test_start "Package.json validation"
    
    if [ -f "package.json" ]; then
        # Check if package.json is valid JSON
        if node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf-8'))" &> /dev/null; then
            test_pass "package.json is valid JSON"
        else
            test_fail "package.json has invalid JSON syntax"
            return 1
        fi
        
        # Check for required scripts
        local required_scripts=("build" "start" "dev")
        for script in "${required_scripts[@]}"; do
            if node -e "const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf-8')); if (!pkg.scripts || !pkg.scripts['$script']) process.exit(1)" &> /dev/null; then
                test_pass "Script '$script' is defined in package.json"
            else
                test_fail "Script '$script' is missing from package.json"
                return 1
            fi
        done
    else
        test_fail "package.json is missing"
        return 1
    fi
}

# Functional tests (only run if requested)
test_container_startup() {
    test_start "Container startup test"
    
    log "Starting bgutil-provider container..."
    if docker run -d --name test-bgutil-provider -p 4417:4416 brainicism/bgutil-ytdlp-pot-provider:latest &> /dev/null; then
        sleep 10
        
        # Check if bgutil-provider is responding
        if curl -f -s http://localhost:4417/health &> /dev/null; then
            test_pass "bgutil-provider container started and is healthy"
        else
            test_fail "bgutil-provider container is not responding"
        fi
        
        # Clean up
        docker stop test-bgutil-provider &> /dev/null || true
        docker rm test-bgutil-provider &> /dev/null || true
    else
        test_fail "Failed to start bgutil-provider container"
        return 1
    fi
}

# Main test execution
run_static_tests() {
    log "🚀 Starting Video Pipeline Container Validation"
    log "Running static validation tests..."
    
    test_docker_available
    test_docker_compose_available
    test_dockerfile_syntax
    test_docker_compose_syntax
    test_bgutil_provider_accessibility
    test_environment_files
    test_helper_scripts
    test_documentation
    test_essential_directories
    test_package_json
}

run_build_tests() {
    log "Running build validation tests..."
    
    test_build_development_image
    test_build_production_image
}

run_functional_tests() {
    log "Running functional tests..."
    
    test_container_startup
}

show_results() {
    echo ""
    echo "========================================"
    log "📊 Test Results Summary"
    echo "========================================"
    echo "Total Tests: $TOTAL_TESTS"
    echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
    echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
    
    if [ $TESTS_FAILED -eq 0 ]; then
        echo ""
        log "🎉 All tests passed! Your containerized setup is ready."
        log "Next steps:"
        log "  - Run './docker-helper.sh dev' to start development environment"
        log "  - Run './docker-helper.sh prod' to start production environment"
        log "  - Run './deploy-ecs.sh' to deploy to AWS ECS"
    else
        echo ""
        error "❌ Some tests failed. Please review the failures above."
        exit 1
    fi
}

# Command line argument handling
case "${1:-static}" in
    "static")
        run_static_tests
        ;;
    "build")
        run_static_tests
        run_build_tests
        ;;
    "full")
        run_static_tests
        run_build_tests
        run_functional_tests
        ;;
    "help")
        echo "Video Pipeline Container Validation"
        echo "Usage: $0 [static|build|full|help]"
        echo ""
        echo "  static  - Run static validation tests (default)"
        echo "  build   - Run static + build tests"
        echo "  full    - Run all tests including functional tests"
        echo "  help    - Show this help message"
        echo ""
        echo "Static tests validate configuration without building images."
        echo "Build tests actually build the Docker images."
        echo "Functional tests start containers and test connectivity."
        exit 0
        ;;
    *)
        error "Unknown test type: $1. Use 'help' for usage information."
        exit 1
        ;;
esac

show_results
