@echo off
chcp 65001 >nul
setlocal
title 安装图片识别环境

set "ROOT=%~dp0"
set "ENV=%ROOT%.ocr-env"
set "DATA=%ROOT%data"
set "PY310=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"

echo.
echo  ============================================================
echo   安装图片识别环境（本地 OCR，图片不出本机）
echo  ============================================================
echo.
echo   全部内容会装进下面一个文件夹，卸载时删掉即可：
echo   %ENV%
echo   预计占用约 330 MB，模型已随包分发，运行时不再下载。
echo.

if exist "%ENV%\Scripts\python.exe" (
  echo   [信息] 环境已存在，跳过安装。
  goto run_ocr
)

if not exist "%PY310%" (
  echo   [错误] 没找到 Python 3.10：%PY310%
  echo          请先安装 Python 3.10 后重试。
  echo.
  pause
  exit /b 1
)

echo   正在创建隔离环境...
"%PY310%" -m venv "%ENV%"
if not exist "%ENV%\Scripts\python.exe" (
  echo   [错误] 创建环境失败。
  pause
  exit /b 1
)

echo.
echo   正在安装依赖（使用清华镜像，约 330 MB，请耐心等待）...
"%ENV%\Scripts\python.exe" -m pip install --no-cache-dir --quiet ^
  -i https://pypi.tuna.tsinghua.edu.cn/simple ^
  rapidocr onnxruntime pillow
if errorlevel 1 (
  echo.
  echo   [错误] 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)

echo   [完成] 环境安装成功。

:run_ocr
echo.
set /p "RUNNOW= 现在就开始识别图片文字吗 ?  (Y/N) "
if /i not "%RUNNOW%"=="Y" goto ask_vlm

echo.
echo   开始识别（可随时按 Ctrl+C 中断，已识别的部分会被保留）...
echo.
set PYTHONIOENCODING=utf-8
"%ENV%\Scripts\python.exe" "%ROOT%scripts\image_ocr.py"
if errorlevel 1 (
  echo.
  echo   [提示] 识别过程有报错，已完成的进度已保存，
  echo          再次运行会从断点继续。
)

:ask_vlm
echo.
if not exist "%DATA%\glm_key.txt" (
  echo   [提示] 想在「查看备份.html」里搜「猫」「舞台」这类照片内容，
  echo          可把智谱 API Key 填进 data\glm_key.txt，
  echo          再运行「更新备份.cmd」（免费模型，只上传没有文字的照片）。
  goto done
)

set /p "RUNVLM= 现在也为「没有文字的照片」生成内容描述吗 ?  (Y/N) "
if /i not "%RUNVLM%"=="Y" goto done

echo.
echo   开始生成（云端智谱免费模型，可能较慢，可 Ctrl+C 中断）...
echo.
set PYTHONIOENCODING=utf-8
"%ENV%\Scripts\python.exe" -u "%ROOT%scripts\image_vlm.py"
if errorlevel 1 (
  echo.
  echo   [提示] 过程有报错，已完成的进度已保存，再次运行会从断点继续。
)

:done
echo.
echo  ============================================================
echo   完成。使用方式：
echo     - 在「查看备份.html」搜索框直接搜图片里的文字与内容描述
echo     - 改 Key 或删索引：运行「卸载OCR环境.cmd」
echo  ============================================================
echo.
pause
endlocal
