# Contributing to Grid Core

Thank you for your interest in contributing to Grid Core! This document provides guidelines and information for contributors.

## 🤝 How to Contribute

### Reporting Issues

- Use the [GitHub Issues](https://github.com/gridplatform/grid-core/issues) to report bugs
- Provide detailed information about the issue
- Include steps to reproduce the problem
- Attach relevant logs and error messages

### Suggesting Features

- Use the [GitHub Discussions](https://github.com/gridplatform/grid-core/discussions) for feature requests
- Describe the use case and expected behavior
- Consider the impact on existing functionality

### Code Contributions

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/your-feature-name`
3. **Make your changes** following our coding standards
4. **Add tests** for new functionality
5. **Update documentation** as needed
6. **Commit your changes**: `git commit -m "Add your feature"`
7. **Push to your fork**: `git push origin feature/your-feature-name`
8. **Create a Pull Request**

## 📋 Development Guidelines

### Code Style

- Follow [TypeScript best practices](https://typescript-eslint.io/rules/)
- Use [Prettier](https://prettier.io/) for code formatting
- Use [ESLint](https://eslint.org/) for linting
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Type Safety

- Use TypeScript strict mode
- Define interfaces for all data structures
- Use proper typing for function parameters and return values
- Avoid `any` type unless absolutely necessary

### Testing

- Write unit tests for all new functionality
- Maintain test coverage above 80%
- Use [Jest](https://jestjs.io/) for testing
- Include integration tests for API endpoints
- Test error cases and edge conditions

### API Design

- Follow RESTful conventions
- Use proper HTTP status codes
- Implement proper error handling
- Add request/response validation
- Document all API endpoints

## 🧪 Testing

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm test -- src/controllers/auth.test.ts
```

### Test Structure

```
tests/
├── unit/              # Unit tests
│   ├── controllers/
│   ├── services/
│   ├── models/
│   └── utils/
├── integration/       # Integration tests
│   ├── api/
│   └── database/
└── fixtures/          # Test fixtures
    ├── users.json
    └── infrastructure.json
```

## 🏗️ Project Structure

### Adding New API Endpoints

1. Define route in `src/routes/`
2. Create controller in `src/controllers/`
3. Add service logic in `src/services/`
4. Add validation schemas
5. Add tests
6. Update API documentation

### Adding New Services

1. Create service class in `src/services/`
2. Add interfaces in `src/types/`
3. Add error handling
4. Add tests
5. Update documentation

## 📝 Commit Messages

Use clear, descriptive commit messages:

```
feat: add user authentication endpoint
fix: resolve memory leak in infrastructure service
docs: update API documentation
test: add unit tests for cost optimization
refactor: improve error handling in controllers
```

## 🔍 Code Review Process

1. **Automated Checks**: All PRs must pass CI/CD checks
2. **Code Review**: At least one maintainer must approve
3. **Testing**: All tests must pass
4. **Documentation**: Documentation must be updated
5. **Performance**: Consider performance impact

## 🐛 Bug Reports

When reporting bugs, please include:

- **Description**: Clear description of the issue
- **Steps to Reproduce**: Detailed steps to reproduce
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: Node.js version, OS, dependencies
- **Logs**: Relevant error messages and logs

## 💡 Feature Requests

When suggesting features:

- **Use Case**: Describe the problem you're trying to solve
- **Proposed Solution**: How you think it should work
- **Alternatives**: Other solutions you've considered
- **Additional Context**: Any other relevant information

## 📚 Resources

- [Grid Platform Documentation](https://docs.gridplatform.org)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Express.js Documentation](https://expressjs.com/)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

## 🤔 Questions?

- **GitHub Discussions**: [Ask questions](https://github.com/gridplatform/grid-core/discussions)
- **Discord**: [Join our community](https://discord.gg/gridplatform)
- **Email**: [Contact us](mailto:support@gridplatform.org)

Thank you for contributing to Grid Core! 🚀
