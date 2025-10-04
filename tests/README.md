# Tests

This directory contains all test files for Grid Core API.

## Structure

- `unit/` - Unit tests for individual functions and classes
- `integration/` - Integration tests for API endpoints and database operations
- `fixtures/` - Test data and mock objects

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## Test Guidelines

- Write tests for all new functionality
- Maintain test coverage above 80%
- Use descriptive test names
- Test both success and error cases
- Mock external dependencies
