# Soporte para Archivos ZIP en el glTF Viewer

## Descripción

El viewer ahora soporta archivos ZIP que contienen modelos glTF con sus assets asociados (archivos .bin, texturas, etc.). Esto permite cargar modelos complejos que están distribuidos en múltiples archivos desde URLs de S3.

## Funcionalidades Implementadas

### 1. Detección Automática de Archivos ZIP
- El sistema detecta automáticamente si una URL apunta a un archivo ZIP (extensión .zip)
- Se integra con el sistema existente de detección de URLs S3

### 2. Descarga y Extracción
- Descarga el archivo ZIP completo desde S3
- Extrae todos los archivos del ZIP usando JSZip
- Crea un mapa de archivos extraídos para referencia rápida

### 3. Carga de Modelos glTF
- Busca automáticamente el archivo .gltf principal en el ZIP
- Carga el modelo usando el GLTFLoader de Three.js
- Maneja assets relativos (archivos .bin, texturas) desde los archivos extraídos

### 4. Manejo de Assets
- Los archivos .bin, texturas (.jpg, .png, .webp) y otros assets se cargan desde el ZIP
- Se crean blob URLs temporales para cada asset
- Limpieza automática de memoria al finalizar la carga

## Flujo de Carga

```
URL ZIP S3 → Fetch ZIP → JSZip.extract() → Encontrar .gltf → GLTFLoader → Visualización
```

## Tipos de Archivo Soportados

### Archivos Requeridos
- **.gltf**: Archivo principal del modelo (requerido)

### Archivos Opcionales
- **.bin**: Datos binarios de geometría
- **.jpg/.jpeg**: Texturas en formato JPEG
- **.png**: Texturas en formato PNG
- **.webp**: Texturas en formato WebP
- **.ktx2**: Texturas comprimidas
- **.draco**: Geometría comprimida

## Manejo de Errores

El sistema incluye manejo específico de errores para archivos ZIP:

- **No GLTF file found**: Si el ZIP no contiene archivos .gltf
- **CORS errors**: Problemas de configuración CORS en S3
- **Network errors**: Problemas de conectividad
- **Invalid ZIP**: Archivos ZIP corruptos o inválidos

## Compatibilidad

- Funciona con URLs S3 firmadas (signed URLs)
- Compatible con el sistema existente de carga de archivos GLB
- Mantiene compatibilidad con drag & drop de archivos locales
- Soporta todos los formatos de textura y compresión existentes

## Ejemplo de Uso

```javascript
// URL de ejemplo para un archivo ZIP en S3
const zipUrl = "https://bucket.s3.amazonaws.com/model.zip?AWSAccessKeyId=...&Signature=...";

// El viewer detectará automáticamente que es un ZIP y lo procesará
viewer.load(zipUrl, '', new Map());
```

## Limitaciones

- El archivo ZIP debe contener al menos un archivo .gltf
- Se usa el primer archivo .gltf encontrado como archivo principal
- Los archivos deben estar en la raíz del ZIP (no en subcarpetas)
- Tamaño máximo recomendado: 100MB (limitación de S3 signed URLs)

## Dependencias

- **JSZip**: Para extracción de archivos ZIP
- **Three.js GLTFLoader**: Para carga de modelos glTF
- **Fetch API**: Para descarga de archivos desde S3
