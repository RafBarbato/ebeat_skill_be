@echo off
start "ebeat backend" cmd /k "cd alexa-supabase-backend && node --env-file=.env be.js"
start "ebeat ngrok" cmd /k "ngrok http --domain=bibliopolar-cadence-unenrolled.ngrok-free.dev 3000"
