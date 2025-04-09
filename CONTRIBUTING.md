# Contributing to Pulls with Spice Action

Thank you for considering contributing to Pulls with Spice Action! This document outlines the process and guidelines for contributing to this project.

## Code of Conduct

By participating in this project, you agree to abide by our code of conduct, which expects all contributors to be respectful and inclusive.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/enforce-issue-quality-action.git`
3. Create a branch for your changes: `git checkout -b feature/your-feature-name`

## Development Process

1. Install dependencies:

   ```bash
   npm install
   ```

2. Make your changes

3. Build the project:

   ```bash
   npm run build
   ```

4. Test your changes:

   ```bash
   npm test
   ```

5. Commit your changes:

   ```bash
      git add .
      git commit -m "feat: add your feature description"
   ```

## Commit Message Guidelines

We follow conventional commits for our commit messages:

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that don't affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `test`: Adding or improving tests
- `chore`: Changes to the build process or auxiliary tools

## Pull Request Process

1. Update the README.md with details of your changes if needed
2. Make sure your code passes all tests
3. Submit a pull request against the `main` branch
4. Ensure PR has a descriptive title and detailed description

## Issue Reporting

When reporting issues, please use one of these templates:

### Bug Report

- Clear and concise description of the bug
- Steps to reproduce
- Expected behavior
- Screenshots if applicable
- Environment details (OS, browser, etc.)

### Feature Request

- Clear description of the feature
- Explanation of why this feature would be valuable
- Any alternative solutions considered

## License

By contributing to this project, you agree that your contributions will be licensed under the project's [Apache 2.0 License](LICENSE).

## Questions?

If you have any questions about contributing, please open an issue with the "question" label.

## Publishing

When releasing a new version of the action, follow these steps:

1. Update version in package.json and package-lock.json
2. Create a git tag with an appropriate version number:

   ```bash
   git tag -a -m "Release version x.y.z" vx.y.z
   ```

3. Push the tag to the repository:

   ```bash
   git push --follow-tags
   ```

4. Create a GitHub release based on the tag with release notes
