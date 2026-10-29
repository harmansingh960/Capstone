# Orchestr — Version 0.2

**Phase 2: Authentication and Basic User Interface**

## Overview

Orchestr is a team workflow management application being developed to help teams organize work, assign responsibilities, track progress, and manage deliverables.

Version 0.2 builds on the initial project foundation by introducing authentication and a basic user interface for account management.

## Technology Stack

- **Framework:** Next.js App Router
- **Frontend:** React and TypeScript
- **Styling:** Tailwind CSS
- **Authentication:** Better Auth
- **Database:** MongoDB Atlas
- **Database Driver:** Official MongoDB Node.js driver
- **Development Environment:** Docker and Docker Compose
- **Version Control:** Git and GitHub

## Features Implemented

### 1. Authentication

- Email and password account registration.
- Email and password login.
- Password hashing handled by Better Auth.
- Session creation and retrieval.
- Sign-out functionality.
- Protected dashboard access for authenticated users.
- Redirects unauthenticated users to the login page.
- Authentication error and loading states in the forms.

### 2. Basic User Interface

- Signup page for creating an account.
- Login page for existing users.
- Dashboard placeholder displaying the authenticated user's name and email.
- Sign-out button on the dashboard.
- Navigation links between the home, signup, login, and dashboard pages.
- Basic loading indicators and error messages for authentication actions.

### 3. Database Connectivity

- MongoDB Atlas integration.
- Shared MongoDB client for database operations and Better Auth.
- Environment-based configuration for database and authentication settings.
- Health endpoint at `/api/health` to verify database connectivity.

### 4. Development Environment

- Docker-based local development.
- Docker Compose configuration for the Next.js application.
- Environment variables loaded from `.env.local`.
- `.env.example` provided as a template for required environment variables.
- Git ignore rules for local environment files and generated files.

## Authentication Flow

The current authentication flow is:

1. A new user registers with a name, email, and password.
2. Better Auth creates the account and establishes a session.
3. The authenticated user is redirected to the dashboard.
4. The dashboard retrieves and displays the user's information.
5. Signing out clears the session cookies and returns the user to the login page.
6. Unauthenticated users attempting to access the dashboard are redirected to login.

The authentication API has been manually verified for account creation, session retrieval, and sign-out.

## Environment Configuration

Create a `.env.local` file in the project root with the following variables:

```dotenv
MONGODB_URI="your-mongodb-atlas-connection-string"
MONGODB_DB="orchestr_dev"
BETTER_AUTH_SECRET="your-generated-secret"
BETTER_AUTH_URL="http://localhost:3000"
```

Use your own MongoDB Atlas connection string and generate a secure, unique Better Auth secret.

**Never commit `.env.local` or real credentials to GitHub.** Use `.env.example` to document the required variable names with safe placeholder values.

## Running Locally

Start the application using Docker Compose:

```bash
docker compose up --build
```

Open the application at:

`http://localhost:3000`

Useful endpoints:

- `/` — Home page
- `/signup` — Account registration
- `/login` — Login
- `/dashboard` — Protected dashboard
- `/api/health` — Database health check
- `/api/auth/get-session` — Current authentication session

## Current Scope

Version 0.2 focuses on the authentication foundation and basic user interface. It does not yet implement the complete team workflow management system.

Planned future capabilities include organizations and memberships, teams, projects, task assignment, subtasks, deadlines, deliverable submissions, reviews, approvals, blockers, extension requests, and activity history.

## Version History

- **Version 0.1:** Initial project foundation, Docker development setup, MongoDB Atlas connectivity, and health endpoint.
- **Version 0.2:** Better Auth integration, signup and login pages, session handling, protected dashboard, and sign-out functionality.

## Status

The authentication API has been tested locally, including account creation, session retrieval, and sign-out. The basic authentication UI has been implemented; browser-flow checks should be completed after the latest loading-state fixes.

Orchestr remains under active development.