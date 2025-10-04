# Grid Core API

![Grid Banner](readme-assets/banner.png)

> **The heart of Grid Platform** - Infrastructure Orchestration Platform API

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express.js-404D59?logo=express&logoColor=white)](https://expressjs.com/)

## 🎯 Overview

Grid Core is the central API service that powers the Grid Infrastructure Orchestration Platform. It provides infrastructure deployment, management, and orchestration capabilities across multiple cloud providers (GCP, AWS, Azure).

## ✨ Key Features

- **Multi-Cloud Support**: Deploy to GCP, AWS, and Azure
- **Infrastructure as Code**: Terraform-based deployments
- **Real-time Status**: WebSocket updates for deployment progress
- **Environment Management**: Create, clone, and manage environments
- **Release Queue**: Prevent concurrent deployments
- **Built-in Monitoring**: Automatic health checks and metrics
- **RESTful API**: Clean, documented endpoints

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Grid UI       │    │   Grid Core     │    │  Grid Terraform │
│   (Frontend)    │◄──►│   (This API)    │◄──►│  (Infrastructure)│
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │   PostgreSQL    │
                       │   + Redis       │
                       └─────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- PostgreSQL 14+
- Redis 6+
- Terraform 1.5+

### Installation

```bash
# Clone the repository
git clone https://github.com/gridplatform/grid-core.git
cd grid-core

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Set up your environment variables
# Edit .env with your database and cloud credentials

# Run database migrations
npm run migrate

# Start the development server
npm run dev
```

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/grid_core
REDIS_URL=redis://localhost:6379

# Cloud Credentials
GCP_PROJECT_ID=your-gcp-project
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AZURE_CLIENT_ID=your-azure-client-id

# API Configuration
PORT=3000
NODE_ENV=development
JWT_SECRET=your-jwt-secret
```

## 📚 API Documentation

### Core Endpoints

#### Infrastructure Deployment
```http
POST /api/v1/infrastructure/deploy
Content-Type: application/json

{
  "provider": "gcp",
  "region": "us-central1",
  "resources": [
    {
      "type": "vpc",
      "name": "main-vpc",
      "config": {
        "cidr": "10.0.0.0/16"
      }
    }
  ]
}
```

#### Environment Management
```http
POST /api/v1/environments
Content-Type: application/json

{
  "name": "production",
  "provider": "gcp",
  "region": "us-central1",
  "template": "web-app"
}
```

#### Real-time Updates
```javascript
// WebSocket connection for real-time updates
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log('Deployment update:', update);
};
```

## 🛠️ Development

### Project Structure

```
grid-core/
├── src/
│   ├── controllers/     # API route handlers
│   ├── services/        # Business logic
│   ├── models/          # Database models
│   ├── middleware/      # Express middleware
│   ├── routes/          # API routes
│   ├── utils/           # Utility functions
│   └── types/           # TypeScript types
├── tests/               # Test files
├── docs/                # API documentation
└── scripts/             # Build and deployment scripts
```

### Available Scripts

```bash
# Development
npm run dev              # Start development server
npm run build            # Build for production
npm run start            # Start production server

# Testing
npm run test             # Run unit tests
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage

# Database
npm run migrate          # Run database migrations
npm run seed             # Seed database with test data
npm run db:reset         # Reset database

# Linting
npm run lint             # Run ESLint
npm run lint:fix         # Fix ESLint issues
npm run format           # Format code with Prettier
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --grep "Infrastructure"

# Run with coverage
npm run test:coverage
```

## 🔧 Configuration

### Cloud Provider Setup

#### Google Cloud Platform
```bash
# Install gcloud CLI
# Authenticate
gcloud auth login
gcloud auth application-default login

# Set project
gcloud config set project YOUR_PROJECT_ID
```

#### AWS
```bash
# Install AWS CLI
# Configure credentials
aws configure
```

#### Azure
```bash
# Install Azure CLI
# Login
az login
```

## 📊 Monitoring

Grid Core includes built-in monitoring capabilities:

- **Health Checks**: `/health` endpoint
- **Metrics**: Prometheus-compatible metrics
- **Logging**: Structured JSON logging
- **Tracing**: Request tracing with correlation IDs

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [Grid Docs](https://github.com/gridplatform/grid-docs)
- **Issues**: [GitHub Issues](https://github.com/gridplatform/grid-core/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gridplatform/grid-core/discussions)

## 🔗 Related Projects

- [Grid UI](https://github.com/gridplatform/grid-ui) - Frontend interface
- [Grid Terraform](https://github.com/gridplatform/grid-terraform) - Infrastructure modules
- [Grid Operator](https://github.com/gridplatform/grid-operator) - Kubernetes operator
- [Grid Docs](https://github.com/gridplatform/grid-docs) - Documentation

---

**Built with ❤️ by the Grid Platform team**