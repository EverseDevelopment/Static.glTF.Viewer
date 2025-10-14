import WebGL from 'three/addons/capabilities/WebGL.js';
import { Viewer } from './viewer.js';
import { SimpleDropzone } from 'simple-dropzone';
import { Validator } from './validator.js';
import { Footer } from './components/footer';
import queryString from 'query-string';

window.VIEWER = {};

if (!(window.File && window.FileReader && window.FileList && window.Blob)) {
    console.error('The File APIs are not fully supported in this browser.');
} else if (!WebGL.isWebGLAvailable()) {
    console.error('WebGL is not supported in this browser.');
}

class App {
    /**
     * @param  {Element} el
     * @param  {Location} location
     */
    constructor(el, location) {
        const query = queryString.parse(location.search);
        this.options = {
            kiosk: Boolean(query.kiosk),
            model: query.file || '',
            preset: query.preset || '',
            cameraPosition: query.cameraPosition ? query.cameraPosition.split(',').map(Number) : null,
        };

        this.el = el;
        this.viewer = null;
        this.viewerEl = null;
        this.spinnerEl = el.querySelector('.spinner');
        this.dropEl = el.querySelector('.dropzone');
        this.inputEl = el.querySelector('#file-input');
        this.validator = new Validator(el);

        this.createDropzone();
        this.hideSpinner();

        const options = this.options;

        if (options.kiosk) {
            const headerEl = document.querySelector('header');
            headerEl.style.display = 'none';
        }

        // Check for S3 signed URL in the pathname (after a dash)
        const s3Url = this.extractS3UrlFromPath(location.pathname);
        if (s3Url) {
            console.log('Using S3 URL from pathname:', s3Url.substring(0, 200) + '...');
            this.view(s3Url, '', new Map());
        } else if (options.model) {
            console.log('Using model from query parameter:', options.model.substring(0, 200) + '...');
            
            // Check if the model parameter is Base64 encoded
            let modelUrl = options.model;
            try {
                // Try to decode as Base64 first
                const decoded = atob(options.model);
                if (this.isValidUrl(decoded)) {
                    console.log('Successfully decoded Base64 URL from query parameter');
                    modelUrl = decoded;
                }
            } catch (e) {
                console.log('Query parameter is not Base64 encoded, using as-is');
            }
            
            this.view(modelUrl, '', new Map());
        }
    }

    /**
     * Extracts S3 signed URL from the pathname if it follows the pattern: /-<encoded-url>
     * Supports both URL encoding and Base64 encoding
     * @param {string} pathname - The URL pathname
     * @returns {string|null} - The decoded S3 URL or null if not found
     */
    extractS3UrlFromPath(pathname) {
        // Look for pattern: /-<encoded-url>
        const match = pathname.match(/^\/-(.+)$/);
        if (!match) return null;

        try {
            const encodedUrl = match[1];
            let decodedUrl;
            
            // Try Base64 decoding first (more reliable for long URLs)
            try {
                decodedUrl = atob(encodedUrl);
                console.log('Successfully decoded using Base64');
            } catch (base64Error) {
                console.log('Base64 decoding failed, trying URL decoding');
                
                // Fallback to URL decoding
                try {
                    // First try: standard decodeURIComponent
                    decodedUrl = decodeURIComponent(encodedUrl);
                } catch (e1) {
                    try {
                        // Second try: decode with replace for common issues
                        decodedUrl = decodeURIComponent(encodedUrl.replace(/\+/g, '%20'));
                    } catch (e2) {
                        try {
                            // Third try: manual decoding for problematic characters
                            decodedUrl = encodedUrl
                                .replace(/%2B/g, '+')
                                .replace(/%2F/g, '/')
                                .replace(/%3D/g, '=')
                                .replace(/%3A/g, ':')
                                .replace(/%3F/g, '?')
                                .replace(/%26/g, '&');
                        } catch (e3) {
                            console.error('All URL decoding attempts failed:', { e1, e2, e3 });
                            return null;
                        }
                    }
                }
            }
            
            console.log('Extracted S3 URL from pathname:', {
                pathname: pathname.substring(0, 100) + '...',
                encodedUrlLength: encodedUrl.length,
                decodedUrlLength: decodedUrl.length,
                decodedUrl: decodedUrl.substring(0, 200) + '...',
                hasSignature: decodedUrl.includes('Signature'),
                hasExpires: decodedUrl.includes('Expires'),
                hasXAmzSignature: decodedUrl.includes('X-Amz-Signature'),
                hasXAmzSecurityToken: decodedUrl.includes('x-amz-security-token')
            });
            
            // Basic validation to ensure it looks like a URL
            if (this.isValidUrl(decodedUrl)) {
                return decodedUrl;
            }
        } catch (error) {
            console.warn('Failed to decode S3 URL from pathname:', error);
        }
        
        return null;
    }

    /**
     * Validates if a string is a valid URL
     * @param {string} url - The URL string to validate
     * @returns {boolean} - True if valid URL
     */
    isValidUrl(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Sets up the drag-and-drop controller.
     */
    createDropzone() {
        const dropCtrl = new SimpleDropzone(this.dropEl, this.inputEl);
        dropCtrl.on('drop', ({ files }) => this.load(files));
        dropCtrl.on('dropstart', () => this.showSpinner());
        dropCtrl.on('droperror', () => this.hideSpinner());
    }

    /**
     * Sets up the view manager.
     * @return {Viewer}
     */
    createViewer() {
        this.viewerEl = document.createElement('div');
        this.viewerEl.classList.add('viewer');
        this.dropEl.innerHTML = '';
        this.dropEl.appendChild(this.viewerEl);
        this.viewer = new Viewer(this.viewerEl, this.options);
        return this.viewer;
    }

    /**
     * Loads a fileset provided by user action.
     * @param  {Map<string, File>} fileMap
     */
    load(fileMap) {
        let rootFile;
        let rootPath;
        Array.from(fileMap).forEach(([path, file]) => {
            if (file.name.match(/\.(gltf|glb)$/)) {
                rootFile = file;
                rootPath = path.replace(file.name, '');
            }
        });

        if (!rootFile) {
            this.onError('No .gltf or .glb asset found.');
        }

        this.view(rootFile, rootPath, fileMap);
    }

    /**
     * Passes a model to the viewer, given file and resources.
     * @param  {File|string} rootFile
     * @param  {string} rootPath
     * @param  {Map<string, File>} fileMap
     */
    view(rootFile, rootPath, fileMap) {
        if (this.viewer) this.viewer.clear();

        const viewer = this.viewer || this.createViewer();

        const fileURL = typeof rootFile === 'string' ? rootFile : URL.createObjectURL(rootFile);

        const cleanup = () => {
            this.hideSpinner();
            if (typeof rootFile === 'object') URL.revokeObjectURL(fileURL);
        };

        // Show spinner when loading from URL
        if (typeof rootFile === 'string') {
            this.showSpinner();
        }

        viewer
            .load(fileURL, rootPath, fileMap)
            .catch((e) => {
                // Enhanced error handling for S3 URLs
                if (typeof rootFile === 'string') {
                    this.onS3UrlError(e, rootFile);
                } else {
                    this.onError(e);
                }
            })
            .then((gltf) => {
                // TODO: GLTFLoader parsing can fail on invalid files. Ideally,
                // we could run the validator either way.
                // if (!this.options.kiosk) {
                //  this.validator.validate(fileURL, rootPath, fileMap, gltf);
                // }
                cleanup();
            });
    }

    /**
     * Enhanced error handling for S3 URL loading
     * @param  {Error} error
     * @param  {string} url
     */
    onS3UrlError(error, url) {
        let message = (error || {}).message || error.toString();
        
        if (message.includes('CORS_ERROR') || message.includes('Failed to fetch')) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'glTF file';
            
            message = `CORS Error: Unable to load the ${fileType} from the S3 URL.\n\n` +
                     'This is a CORS (Cross-Origin Resource Sharing) issue. The S3 bucket needs to be configured to allow requests from your domain.\n\n' +
                     'To fix this, add the following CORS configuration to your S3 bucket:\n\n' +
                     '{\n' +
                     '  "CORSRules": [\n' +
                     '    {\n' +
                     '      "AllowedHeaders": ["*"],\n' +
                     '      "AllowedMethods": ["GET", "HEAD"],\n' +
                     '      "AllowedOrigins": ["*"],\n' +
                     '      "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],\n' +
                     '      "MaxAgeSeconds": 3000\n' +
                     '    }\n' +
                     '  ]\n' +
                     '}\n\n' +
                     'Note: For signed URLs, make sure your CORS policy allows the specific headers that AWS uses in the signature.';
        } else if (message.includes('CORS_403')) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'glTF file';
            message = `Access Denied (403): The S3 bucket is blocking requests from your domain.\n\n` +
                     'This is a CORS configuration issue. The bucket owner needs to add your domain to the CORS allowed origins.';
        } else if (message.includes('CORS_404')) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'glTF file';
            message = `File Not Found (404): The ${fileType} was not found at the provided URL.\n\n` +
                     'The file may have been moved, deleted, or the URL may be incorrect.';
        } else if (message.includes('No GLTF file found in the ZIP archive')) {
            message = 'ZIP Archive Error: No GLTF file found in the ZIP archive.\n\n' +
                     'The ZIP file must contain at least one .gltf file to be viewable. Please check that your ZIP file contains:\n' +
                     '• A .gltf file (required)\n' +
                     '• Associated .bin files (if referenced by the GLTF)\n' +
                     '• Texture files (.jpg, .png, .webp) if referenced by the GLTF';
        } else if (message.match(/ProgressEvent/) || message.match(/Failed to fetch/)) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'glTF file';
            message = `Unable to load the ${fileType} from the provided URL. This could be due to:\n` +
                     '• The URL has expired (S3 signed URLs have time limits)\n' +
                     '• Network connectivity issues\n' +
                     '• CORS restrictions\n' +
                     '• The file is not accessible\n\n' +
                     'Please check the URL and try again.';
        } else if (message.includes('HTML_RESPONSE')) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'GLB file';
            message = `Invalid Response: The server returned an HTML page instead of the ${fileType}.\n\n` +
                     'This usually means:\n' +
                     '• The signed URL has expired\n' +
                     '• The signed URL is malformed\n' +
                     '• The file was moved or deleted\n' +
                     '• There\'s a server configuration issue\n\n' +
                     'Please generate a new signed URL and try again.';
        } else if (message.match(/Unexpected token/)) {
            message = `The file at the provided URL is not a valid glTF file. Error: "${message}"`;
        } else if (error && error.target && error.target instanceof Image) {
            message = 'Missing texture: ' + error.target.src.split('/').pop();
        } else if (message.match(/404/)) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'glTF file';
            message = `The ${fileType} was not found at the provided URL. The file may have been moved or deleted.`;
        } else if (message.match(/403/)) {
            const isZipFile = url.toLowerCase().endsWith('.zip');
            const fileType = isZipFile ? 'ZIP file' : 'glTF file';
            message = `Access denied to the ${fileType}. The URL may have expired or you may not have permission to access this file.`;
        }
        
        window.alert(message);
        console.error('S3 URL loading error:', error);
        console.error('Failed URL:', url);
    }

    /**
     * @param  {Error} error
     */
    onError(error) {
        let message = (error || {}).message || error.toString();
        if (message.match(/ProgressEvent/)) {
            message = 'Unable to retrieve this file. Check JS console and browser network tab.';
        } else if (message.match(/Unexpected token/)) {
            message = `Unable to parse file content. Verify that this file is valid. Error: "${message}"`;
        } else if (error && error.target && error.target instanceof Image) {
            message = 'Missing texture: ' + error.target.src.split('/').pop();
        }
        window.alert(message);
        console.error(error);
    }

    showSpinner() {
        this.spinnerEl.style.display = '';
    }

    hideSpinner() {
        this.spinnerEl.style.display = 'none';
    }
}

// document.body.innerHTML += Footer();

document.addEventListener('DOMContentLoaded', () => {
    const app = new App(document.body, location);

    window.VIEWER.app = app;

    console.info('[glTF Viewer] Debugging data exported as `window.VIEWER`.');
});
