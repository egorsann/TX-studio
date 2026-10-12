@echo off
rem Start TX Studio from the source folder (double-click). Optional argument: a folder to open.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
