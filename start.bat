@echo off
start "ebeat backend" cmd /k "node --env-file=.env be.js"
start "ebeat ngrok" cmd /k "ngrok http --domain=bibliopolar-cadence-unenrolled.ngrok-free.dev 3000"
