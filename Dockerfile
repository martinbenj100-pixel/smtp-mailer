FROM node:18-alpine

WORKDIR /app

# Copie package.json
COPY package*.json ./

# Installe les dépendances
RUN npm ci --only=production

# Copie le code
COPY . .

# Expose le port
EXPOSE 3000

# Commande de démarrage
CMD ["npm", "start"]