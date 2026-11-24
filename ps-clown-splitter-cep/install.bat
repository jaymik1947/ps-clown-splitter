@echo off
chcp 65001 >nul
setlocal
set "SRC=%~dp0"
set "DST=%APPDATA%\Adobe\CEP\extensions\com.clownsplit.cep"

echo ============================================
echo  Clown 分层  -  CEP 插件安装
echo ============================================
echo  目标: %DST%
echo.

if not exist "%DST%" mkdir "%DST%" 2>nul

xcopy "%SRC%CSXS" "%DST%\CSXS\" /E /Y /I /Q >nul
if errorlevel 1 goto failed
xcopy "%SRC%host" "%DST%\host\" /E /Y /I /Q >nul
if errorlevel 1 goto failed

rem 打开未签名扩展的调试模式（HKCU，不需要管理员）
for %%v in (9 10 11 12 13 14) do (
    reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo  安装完成。
echo.
echo  下一步: 完全退出 Photoshop 再重新打开
echo         菜单 窗口 ^> 扩展 ^> Clown 分层
echo.
pause
exit /b 0

:failed
echo.
echo  安装失败: 请确认目标目录可写，或手动复制 CSXS 与 host 两个文件夹到
echo  %DST%
echo.
pause
exit /b 1
