# Orchestr v0.1 — Project Foundation

Orchestr is a full-stack web application currently in its initial development stage. Version 0.1 establishes the core technical foundation for local development and database connectivity.

## Achievements in v0.1

- **Next.js application setup:** Initialized a project using Next.js App Router, React, and TypeScript.
- **Docker development environment:** Configured Docker and Docker Compose to run the application locally using Node.js 24 on Alpine Linux.
- **Development workflow:** Configured source-code mounting and persistent Docker volumes to support Next.js hot reloading and dependency management.
- **MongoDB Atlas integration:** Added the official MongoDB Node.js driver and a reusable database client in `lib/db.ts`.
- **Database health check:** Implemented `/api/health` to verify database connectivity.
- **Environment configuration:** Added `.env.example` for configuration placeholders and configured `.env.local` for local environment variables.
- **Git configuration:** Added `.gitignore` and `.dockerignore` to exclude local secrets, dependencies, generated files, and unnecessary build-context files.
- **Dependency installation:** Resolved the Docker dependency lockfile issue and verified that the Docker image builds successfully.

## Technology Stack

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- Node.js 24 (Alpine Linux)
- Docker and Docker Compose
- MongoDB Atlas
- Official MongoDB Node.js driver

## Running the Project Locally

### Prerequisites

- Docker Desktop
- A MongoDB Atlas cluster and database user

### 1. Configure environment variables

Create a `.env.local` file in the project root, alongside `package.json` and `docker-compose.yml`.

Add your MongoDB Atlas connection details:

```dotenv
MONGODB_URI="mongodb+srv://<username>:<password>@<cluster-host>/?retryWrites=true&w=majority"
MONGODB_DB="orchestr_dev"
```

Replace the placeholders with the actual values from MongoDB Atlas. Ensure special characters in the password are percent-encoded when included in the URI.

Never commit `.env.local` or expose database credentials.

### 2. Start Docker

Open Docker Desktop and wait until the Docker engine is running.

### 3. Start the application

Run the following command from the project root:

```bash
docker compose up --build
```

### 4. Access the application

- Application: http://localhost:3000
- Database health check: http://localhost:3000/api/health

A successful database health check returns:

```json
{
  "ok": true,
  "database": "connected"
}
```

### 5. Stop the application

Press `Ctrl + C` in the terminal running Docker Compose, or use:

```bash
docker compose down
```

## Current Status

The Next.js application runs locally in Docker, the Docker image builds successfully, and MongoDB Atlas connectivity has been verified through the health-check endpoint.

This version establishes the development and database foundation. The application-specific functionality has not yet been implemented in this milestone.