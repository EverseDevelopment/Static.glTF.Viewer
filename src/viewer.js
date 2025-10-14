import {
	AmbientLight,
	AnimationMixer,
	AxesHelper,
	Box3,
	Cache,
	Color,
	DirectionalLight,
	GridHelper,
	HemisphereLight,
	LoaderUtils,
	LoadingManager,
	PMREMGenerator,
	PerspectiveCamera,
	PointsMaterial,
	REVISION,
	Scene,
	SkeletonHelper,
	Vector3,
	WebGLRenderer,
	LinearToneMapping,
	ACESFilmicToneMapping,
} from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import JSZip from 'jszip';

import { GUI } from 'dat.gui';

import { environments } from './environments.js';

const DEFAULT_CAMERA = '[default]';

const MANAGER = new LoadingManager();
const THREE_PATH = `https://unpkg.com/three@0.${REVISION}.x`;
const DRACO_LOADER = new DRACOLoader(MANAGER).setDecoderPath(
	`${THREE_PATH}/examples/jsm/libs/draco/gltf/`,
);
const KTX2_LOADER = new KTX2Loader(MANAGER).setTranscoderPath(
	`${THREE_PATH}/examples/jsm/libs/basis/`,
);

const IS_IOS = isIOS();

const Preset = { ASSET_GENERATOR: 'assetgenerator' };

Cache.enabled = true;

export class Viewer {
	constructor(el, options) {
		this.el = el;
		this.options = options;

		this.lights = [];
		this.content = null;
		this.mixer = null;
		this.clips = [];
		this.gui = null;

		this.state = {
			environment:
				options.preset === Preset.ASSET_GENERATOR
					? environments.find((e) => e.id === 'footprint-court').name
					: environments[1].name,
			background: false,
			playbackSpeed: 1.0,
			actionStates: {},
			camera: DEFAULT_CAMERA,
			wireframe: false,
			skeleton: false,
			grid: false,
			autoRotate: false,

			// Lights
			punctualLights: true,
			exposure: 0.0,
			toneMapping: LinearToneMapping,
			ambientIntensity: 0.3,
			ambientColor: '#FFFFFF',
			directIntensity: 0.8 * Math.PI, // TODO(#116)
			directColor: '#FFFFFF',
			bgColor: '#FAFBFB',

			pointSize: 1.0,
		};

		this.prevTime = 0;

		this.stats = new Stats();
		this.stats.dom.height = '48px';
		[].forEach.call(this.stats.dom.children, (child) => (child.style.display = ''));

		this.backgroundColor = new Color(this.state.bgColor);

		this.scene = new Scene();
		this.scene.background = this.backgroundColor;

		const fov = options.preset === Preset.ASSET_GENERATOR ? (0.8 * 180) / Math.PI : 60;
		const aspect = el.clientWidth / el.clientHeight;
		this.defaultCamera = new PerspectiveCamera(fov, aspect, 0.01, 1000);
		this.activeCamera = this.defaultCamera;
		this.scene.add(this.defaultCamera);

		this.renderer = window.renderer = new WebGLRenderer({ antialias: true });
		this.renderer.setClearColor(0xcccccc);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(el.clientWidth, el.clientHeight);

		this.pmremGenerator = new PMREMGenerator(this.renderer);
		this.pmremGenerator.compileEquirectangularShader();

		this.neutralEnvironment = this.pmremGenerator.fromScene(new RoomEnvironment()).texture;

		this.controls = new OrbitControls(this.defaultCamera, this.renderer.domElement);
		this.controls.screenSpacePanning = true;

		this.el.appendChild(this.renderer.domElement);

		this.cameraCtrl = null;
		this.cameraFolder = null;
		this.animFolder = null;
		this.animCtrls = [];
		this.morphFolder = null;
		this.morphCtrls = [];
		this.skeletonHelpers = [];
		this.gridHelper = null;
		this.axesHelper = null;

		this.addAxesHelper();
		// this.addGUI();
		// if (options.kiosk) this.gui.close();

		this.animate = this.animate.bind(this);
		requestAnimationFrame(this.animate);
		window.addEventListener('resize', this.resize.bind(this), false);
	}

	animate(time) {
		requestAnimationFrame(this.animate);

		const dt = (time - this.prevTime) / 1000;

		this.controls.update();
		this.stats.update();
		this.mixer && this.mixer.update(dt);
		this.render();

		this.prevTime = time;
	}

	render() {
		this.renderer.render(this.scene, this.activeCamera);
		if (this.state.grid) {
			this.axesCamera.position.copy(this.defaultCamera.position);
			this.axesCamera.lookAt(this.axesScene.position);
			this.axesRenderer.render(this.axesScene, this.axesCamera);
		}
	}

	resize() {
		const { clientHeight, clientWidth } = this.el.parentElement;

		this.defaultCamera.aspect = clientWidth / clientHeight;
		this.defaultCamera.updateProjectionMatrix();
		this.renderer.setSize(clientWidth, clientHeight);

		this.axesCamera.aspect = this.axesDiv.clientWidth / this.axesDiv.clientHeight;
		this.axesCamera.updateProjectionMatrix();
		this.axesRenderer.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);
	}

	/**
	 * Checks if a URL is an S3 signed URL
	 * @param {string} url - The URL to check
	 * @returns {boolean} - True if it's an S3 signed URL
	 */
	isS3SignedUrl(url) {
		try {
			const urlObj = new URL(url);
			// Check if it's an S3 URL (s3.amazonaws.com or s3-*.amazonaws.com)
			const isS3Host = urlObj.hostname.includes('s3.amazonaws.com') || 
							urlObj.hostname.includes('s3-') && urlObj.hostname.includes('.amazonaws.com');
			
			// Check if it has S3 signature parameters
			const hasSignature = urlObj.searchParams.has('Signature') || 
								urlObj.searchParams.has('X-Amz-Signature') ||
								urlObj.searchParams.has('AWSAccessKeyId') ||
								urlObj.searchParams.has('X-Amz-Credential');
			
			return isS3Host && hasSignature;
		} catch {
			return false;
		}
	}

	/**
	 * Checks if a URL points to a ZIP file
	 * @param {string} url - The URL to check
	 * @returns {boolean} - True if it's a ZIP file
	 */
	isZipFile(url) {
		try {
			const urlObj = new URL(url);
			const pathname = urlObj.pathname.toLowerCase();
			return pathname.endsWith('.zip');
		} catch {
			return false;
		}
	}

	load(url, rootPath, assetMap) {
		const baseURL = LoaderUtils.extractUrlBase(url);
		const isZip = this.isZipFile(url);
		const isS3SignedUrl = this.isS3SignedUrl(url);

		console.log('File detection:', {
			url: url.substring(0, 200) + '...',
			isZip,
			isS3SignedUrl,
			urlEndsWithZip: url.toLowerCase().endsWith('.zip')
		});

		// For ZIP files, use ZIP loading approach (priority over S3 detection)
		if (isZip) {
			console.log('Using ZIP loading approach');
			return this.loadZipFile(url, rootPath, assetMap);
		}

		// For S3 signed URLs, use a custom loading approach
		if (isS3SignedUrl) {
			console.log('Using S3 loading approach');
			return this.loadS3SignedUrl(url, rootPath, assetMap);
		}

		// Load.
		return new Promise((resolve, reject) => {
			// Intercept and override relative URLs.
			MANAGER.setURLModifier((url, path) => {
				// URIs in a glTF file may be escaped, or not. Assume that assetMap is
				// from an un-escaped source, and decode all URIs before lookups.
				// See: https://github.com/donmccurdy/three-gltf-viewer/issues/146
				const normalizedURL =
					rootPath +
					decodeURI(url)
						.replace(baseURL, '')
						.replace(/^(\.?\/)/, '');

				if (assetMap.has(normalizedURL)) {
					const blob = assetMap.get(normalizedURL);
					const blobURL = URL.createObjectURL(blob);
					blobURLs.push(blobURL);
					return blobURL;
				}

				return (path || '') + url;
			});

			const loader = new GLTFLoader(MANAGER)
				.setCrossOrigin('anonymous')
				.setDRACOLoader(DRACO_LOADER)
				.setKTX2Loader(KTX2_LOADER.detectSupport(this.renderer))
				.setMeshoptDecoder(MeshoptDecoder);

			const blobURLs = [];

			loader.load(
				url,
				(gltf) => {
					window.VIEWER.json = gltf;

					const scene = gltf.scene || gltf.scenes[0];
					const clips = gltf.animations || [];

					if (!scene) {
						// Valid, but not supported by this viewer.
						throw new Error(
							'This model contains no scene, and cannot be viewed here. However,' +
								' it may contain individual 3D resources.',
						);
					}

					this.setContent(scene, clips);

					blobURLs.forEach(URL.revokeObjectURL);

					// See: https://github.com/google/draco/issues/349
					// DRACOLoader.releaseDecoderModule();

					resolve(gltf);
				},
				undefined,
				reject,
			);
		});
	}

	/**
	 * Loads a glTF model from an S3 signed URL with proper CORS handling
	 * @param {string} url - The S3 signed URL
	 * @param {string} rootPath - The root path for assets
	 * @param {Map<string, File>} assetMap - Map of asset files
	 * @returns {Promise} - Promise that resolves with the loaded glTF
	 */
	loadS3SignedUrl(url, rootPath, assetMap) {
		return new Promise((resolve, reject) => {
			console.log('Loading S3 signed URL:', url.substring(0, 200) + '...');
			console.log('URL length:', url.length);
			console.log('URL contains signature:', url.includes('Signature'));
			console.log('URL contains expires:', url.includes('Expires'));
			
			// Try direct loading with GLTFLoader first (simpler approach)
			const baseURL = LoaderUtils.extractUrlBase(url);
			console.log('Base URL extracted:', baseURL);
			
			// Set up URL modifier for relative assets
			MANAGER.setURLModifier((assetUrl, path) => {
				// For S3 signed URLs, we need to handle relative assets differently
				// Try to construct the full S3 URL for assets
				if (assetUrl.startsWith('./') || assetUrl.startsWith('../') || !assetUrl.includes('://')) {
					// This is a relative URL, construct the full S3 URL
					const fullAssetUrl = new URL(assetUrl, baseURL).toString();
					return fullAssetUrl;
				}
				return assetUrl;
			});

			// Create GLTFLoader with no crossOrigin for S3 signed URLs
			const loader = new GLTFLoader(MANAGER)
				.setCrossOrigin(null) // Don't set crossOrigin for S3 signed URLs
				.setDRACOLoader(DRACO_LOADER)
				.setKTX2Loader(KTX2_LOADER.detectSupport(this.renderer))
				.setMeshoptDecoder(MeshoptDecoder);

			console.log('Starting GLTFLoader with URL...');
			
			// Load the glTF directly from the signed URL
			loader.load(
				url,
				(gltf) => {
					console.log('S3 signed URL loaded successfully');
					window.VIEWER.json = gltf;

					const scene = gltf.scene || gltf.scenes[0];
					const clips = gltf.animations || [];

					if (!scene) {
						throw new Error(
							'This model contains no scene, and cannot be viewed here. However,' +
								' it may contain individual 3D resources.',
						);
					}

					this.setContent(scene, clips);
					resolve(gltf);
				},
				(progress) => {
					console.log('Loading progress:', progress);
				},
				(error) => {
					console.error('Direct S3 loading failed, trying fetch approach:', error);
					console.error('Error details:', {
						message: error.message,
						name: error.name,
						stack: error.stack
					});
					
					// If direct loading fails, try the fetch approach
					this.loadS3SignedUrlWithFetch(url, rootPath, assetMap)
						.then(resolve)
						.catch(reject);
				}
			);
		});
	}

	/**
	 * Loads a glTF model from a ZIP file
	 * @param {string} url - The ZIP file URL
	 * @param {string} rootPath - The root path for assets
	 * @param {Map<string, File>} assetMap - Map of asset files
	 * @returns {Promise} - Promise that resolves with the loaded glTF
	 */
	loadZipFile(url, rootPath, assetMap) {
		return new Promise((resolve, reject) => {
			console.log('Loading ZIP file:', url);
			
			// First, fetch the ZIP file
			fetch(url, {
				method: 'GET',
				mode: 'cors',
				credentials: 'omit'
			})
			.then(response => {
				console.log('ZIP fetch response:', {
					status: response.status,
					statusText: response.statusText,
					headers: Object.fromEntries(response.headers.entries()),
					url: response.url
				});
				
				if (!response.ok) {
					if (response.status === 403) {
						throw new Error(`CORS_403: Access denied. The S3 bucket may not have CORS configured for your domain. Status: ${response.status} ${response.statusText}`);
					} else if (response.status === 404) {
						throw new Error(`CORS_404: File not found. Status: ${response.status} ${response.statusText}`);
					} else {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}
				}
				
				return response.blob();
			})
			.then(blob => {
				console.log('ZIP blob received, size:', blob.size);
				
				// Extract the ZIP file
				return JSZip.loadAsync(blob);
			})
			.then(zip => {
				console.log('ZIP file loaded, files:', Object.keys(zip.files));
				
				// Find the main GLTF file
				const gltfFiles = Object.keys(zip.files).filter(name => 
					name.toLowerCase().endsWith('.gltf') && !zip.files[name].dir
				);
				
				if (gltfFiles.length === 0) {
					throw new Error('No GLTF file found in the ZIP archive');
				}
				
				const mainGltfFile = gltfFiles[0]; // Use the first GLTF file found
				console.log('Main GLTF file:', mainGltfFile);
				
				// Extract all files and create a file map
				const extractedFiles = new Map();
				const blobURLs = [];
				
				// Process all files in the ZIP
				const filePromises = Object.keys(zip.files).map(fileName => {
					const zipFile = zip.files[fileName];
					if (zipFile.dir) return Promise.resolve();
					
					return zipFile.async('blob').then(blob => {
						// Create a File object from the blob
						const file = new File([blob], fileName, { type: this.getMimeType(fileName) });
						extractedFiles.set(fileName, file);
						
						// Create blob URL for the file
						const blobURL = URL.createObjectURL(blob);
						blobURLs.push(blobURL);
						
						console.log('Extracted file:', fileName, 'size:', blob.size);
					});
				});
				
				return Promise.all(filePromises).then(() => {
					// Create blob URL for the main GLTF file
					const mainGltfBlob = extractedFiles.get(mainGltfFile);
					const mainGltfBlobURL = URL.createObjectURL(mainGltfBlob);
					blobURLs.push(mainGltfBlobURL);
					
					// Set up URL modifier to use extracted files
					MANAGER.setURLModifier((assetUrl, path) => {
						console.log('URLModifier called with:', { assetUrl, path });
						
						// Decode the URL in case it's encoded
						const decodedUrl = decodeURI(assetUrl);
						
						// Extract just the filename from the URL
						const fileName = decodedUrl.split('/').pop().split('?')[0];
						
						console.log('Looking for file:', fileName, 'in extracted files:', Array.from(extractedFiles.keys()));
						
						// Check if we have this file in our extracted files (by filename)
						if (extractedFiles.has(fileName)) {
							const file = extractedFiles.get(fileName);
							const blobURL = URL.createObjectURL(file);
							blobURLs.push(blobURL);
							console.log('Found file in ZIP, using blob URL:', blobURL);
							return blobURL;
						}
						
						// Also check with the full decoded URL
						if (extractedFiles.has(decodedUrl)) {
							const file = extractedFiles.get(decodedUrl);
							const blobURL = URL.createObjectURL(file);
							blobURLs.push(blobURL);
							console.log('Found file in ZIP (full path), using blob URL:', blobURL);
							return blobURL;
						}
						
						console.log('File not found in ZIP, using original URL:', assetUrl);
						// If not found, return the original URL
						return assetUrl;
					});
					
					// Create GLTFLoader
					const loader = new GLTFLoader(MANAGER)
						.setCrossOrigin('anonymous')
						.setDRACOLoader(DRACO_LOADER)
						.setKTX2Loader(KTX2_LOADER.detectSupport(this.renderer))
						.setMeshoptDecoder(MeshoptDecoder);
					
					// Load the GLTF from the blob URL
					loader.load(
						mainGltfBlobURL,
						(gltf) => {
							console.log('ZIP GLTF loaded successfully');
							window.VIEWER.json = gltf;

							const scene = gltf.scene || gltf.scenes[0];
							const clips = gltf.animations || [];

							if (!scene) {
								throw new Error(
									'This model contains no scene, and cannot be viewed here. However,' +
										' it may contain individual 3D resources.',
								);
							}

							this.setContent(scene, clips);

							// Clean up blob URLs
							blobURLs.forEach(URL.revokeObjectURL);

							resolve(gltf);
						},
						(progress) => {
							console.log('ZIP GLTF loading progress:', progress);
						},
						(error) => {
							// Clean up blob URLs on error
							blobURLs.forEach(URL.revokeObjectURL);
							reject(error);
						}
					);
				});
			})
			.catch(error => {
				console.error('ZIP loading error:', error);
				
				// Enhanced CORS error detection
				if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
					reject(new Error('CORS_ERROR: Failed to fetch the ZIP file. This is likely a CORS issue. The S3 bucket needs to be configured to allow requests from your domain.'));
				} else if (error.message.includes('CORS_403')) {
					reject(error);
				} else if (error.message.includes('CORS_404')) {
					reject(error);
				} else {
					reject(error);
				}
			});
		});
	}

	/**
	 * Gets the MIME type for a file based on its extension
	 * @param {string} fileName - The file name
	 * @returns {string} - The MIME type
	 */
	getMimeType(fileName) {
		const ext = fileName.toLowerCase().split('.').pop();
		const mimeTypes = {
			'gltf': 'model/gltf+json',
			'glb': 'model/gltf-binary',
			'bin': 'application/octet-stream',
			'jpg': 'image/jpeg',
			'jpeg': 'image/jpeg',
			'png': 'image/png',
			'webp': 'image/webp',
			'ktx2': 'image/ktx2',
			'draco': 'application/octet-stream'
		};
		return mimeTypes[ext] || 'application/octet-stream';
	}

	/**
	 * Fallback method using fetch for S3 signed URLs
	 */
	loadS3SignedUrlWithFetch(url, rootPath, assetMap) {
		return new Promise((resolve, reject) => {
			console.log('Trying fetch approach for S3 signed URL:', url);
			
			// First, fetch the glTF file directly to handle CORS properly
			fetch(url, {
				method: 'GET',
				mode: 'cors',
				credentials: 'omit'
				// Remove custom headers to avoid CORS preflight issues
			})
			.then(response => {
				console.log('S3 fetch response:', {
					status: response.status,
					statusText: response.statusText,
					headers: Object.fromEntries(response.headers.entries()),
					url: response.url
				});
				
				if (!response.ok) {
					if (response.status === 403) {
						throw new Error(`CORS_403: Access denied. The S3 bucket may not have CORS configured for your domain. Status: ${response.status} ${response.statusText}`);
					} else if (response.status === 404) {
						throw new Error(`CORS_404: File not found. Status: ${response.status} ${response.statusText}`);
					} else {
						throw new Error(`HTTP ${response.status}: ${response.statusText}`);
					}
				}
				
				// Check if we're getting HTML instead of binary data
				const contentType = response.headers.get('content-type');
				console.log('Response content-type:', contentType);
				
				if (contentType && contentType.includes('text/html')) {
					// We're getting HTML instead of the GLB file
					return response.text().then(html => {
						console.error('Got HTML response instead of GLB file:', html.substring(0, 500));
						throw new Error('HTML_RESPONSE: Received HTML page instead of GLB file. The signed URL may be invalid or expired.');
					});
				}
				
				return response.blob();
			})
			.then(blob => {
				// Create a blob URL for the glTF file
				const blobURL = URL.createObjectURL(blob);
				
				// Set up URL modifier for relative assets
				const baseURL = LoaderUtils.extractUrlBase(url);
				MANAGER.setURLModifier((assetUrl, path) => {
					// For S3 signed URLs, we need to handle relative assets differently
					// Try to construct the full S3 URL for assets
					if (assetUrl.startsWith('./') || assetUrl.startsWith('../') || !assetUrl.includes('://')) {
						// This is a relative URL, construct the full S3 URL
						const fullAssetUrl = new URL(assetUrl, baseURL).toString();
						return fullAssetUrl;
					}
					return assetUrl;
				});

				// Create GLTFLoader with no crossOrigin for S3 URLs
				const loader = new GLTFLoader(MANAGER)
					.setCrossOrigin(null) // Don't set crossOrigin for S3 signed URLs
					.setDRACOLoader(DRACO_LOADER)
					.setKTX2Loader(KTX2_LOADER.detectSupport(this.renderer))
					.setMeshoptDecoder(MeshoptDecoder);

				// Load the glTF from the blob URL
				loader.load(
					blobURL,
					(gltf) => {
						window.VIEWER.json = gltf;

						const scene = gltf.scene || gltf.scenes[0];
						const clips = gltf.animations || [];

						if (!scene) {
							throw new Error(
								'This model contains no scene, and cannot be viewed here. However,' +
									' it may contain individual 3D resources.',
							);
						}

						this.setContent(scene, clips);

						// Clean up the blob URL
						URL.revokeObjectURL(blobURL);

						resolve(gltf);
					},
					undefined,
					(error) => {
						URL.revokeObjectURL(blobURL);
						reject(error);
					}
				);
			})
			.catch(error => {
				console.error('S3 fetch error:', error);
				
				// Enhanced CORS error detection
				if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
					reject(new Error('CORS_ERROR: Failed to fetch the file. This is likely a CORS issue. The S3 bucket needs to be configured to allow requests from your domain.'));
				} else if (error.message.includes('CORS_403')) {
					reject(error);
				} else if (error.message.includes('CORS_404')) {
					reject(error);
				} else {
					reject(error);
				}
			});
		});
	}

	/**
	 * @param {THREE.Object3D} object
	 * @param {Array<THREE.AnimationClip} clips
	 */
	setContent(object, clips) {
		this.clear();

		object.updateMatrixWorld(); // donmccurdy/three-gltf-viewer#330

		const box = new Box3().setFromObject(object);
		const size = box.getSize(new Vector3()).length();
		const center = box.getCenter(new Vector3());

		this.controls.reset();

		object.position.x += object.position.x - center.x;
		object.position.y += object.position.y - center.y;
		object.position.z += object.position.z - center.z;
		this.controls.maxDistance = size * 10;
		this.defaultCamera.near = size / 100;
		this.defaultCamera.far = size * 100;
		this.defaultCamera.updateProjectionMatrix();

		if (this.options.cameraPosition) {
			this.defaultCamera.position.fromArray(this.options.cameraPosition);
			this.defaultCamera.lookAt(new Vector3());
		} else {
			this.defaultCamera.position.copy(center);
			this.defaultCamera.position.x += size / 2.0;
			this.defaultCamera.position.y += size / 5.0;
			this.defaultCamera.position.z += size / 2.0;
			this.defaultCamera.lookAt(center);
		}

		this.setCamera(DEFAULT_CAMERA);

		this.axesCamera.position.copy(this.defaultCamera.position);
		this.axesCamera.lookAt(this.axesScene.position);
		this.axesCamera.near = size / 100;
		this.axesCamera.far = size * 100;
		this.axesCamera.updateProjectionMatrix();
		this.axesCorner.scale.set(size, size, size);

		this.controls.saveState();

		this.scene.add(object);
		this.content = object;

		this.state.punctualLights = true;

		this.content.traverse((node) => {
			if (node.isLight) {
				this.state.punctualLights = false;
			}
		});

		this.setClips(clips);

		this.updateLights();
		// this.updateGUI();
		this.updateEnvironment();
		this.updateDisplay();

		window.VIEWER.scene = this.content;

		this.printGraph(this.content);
	}

	printGraph(node) {
		console.group(' <' + node.type + '> ' + node.name);
		node.children.forEach((child) => this.printGraph(child));
		console.groupEnd();
	}

	/**
	 * @param {Array<THREE.AnimationClip} clips
	 */
	setClips(clips) {
		if (this.mixer) {
			this.mixer.stopAllAction();
			this.mixer.uncacheRoot(this.mixer.getRoot());
			this.mixer = null;
		}

		this.clips = clips;
		if (!clips.length) return;

		this.mixer = new AnimationMixer(this.content);
	}

	playAllClips() {
		this.clips.forEach((clip) => {
			this.mixer.clipAction(clip).reset().play();
			this.state.actionStates[clip.name] = true;
		});
	}

	/**
	 * @param {string} name
	 */
	setCamera(name) {
		if (name === DEFAULT_CAMERA) {
			this.controls.enabled = true;
			this.activeCamera = this.defaultCamera;
		} else {
			this.controls.enabled = false;
			this.content.traverse((node) => {
				if (node.isCamera && node.name === name) {
					this.activeCamera = node;
				}
			});
		}
	}

	updateLights() {
		const state = this.state;
		const lights = this.lights;

		if (state.punctualLights && !lights.length) {
			this.addLights();
		} else if (!state.punctualLights && lights.length) {
			this.removeLights();
		}

		this.renderer.toneMapping = Number(state.toneMapping);
		this.renderer.toneMappingExposure = Math.pow(2, state.exposure);

		if (lights.length === 2) {
			lights[0].intensity = state.ambientIntensity;
			lights[0].color.set(state.ambientColor);
			lights[1].intensity = state.directIntensity;
			lights[1].color.set(state.directColor);
		}
	}

	addLights() {
		const state = this.state;

		if (this.options.preset === Preset.ASSET_GENERATOR) {
			const hemiLight = new HemisphereLight();
			hemiLight.name = 'hemi_light';
			this.scene.add(hemiLight);
			this.lights.push(hemiLight);
			return;
		}

		const light1 = new AmbientLight(state.ambientColor, state.ambientIntensity);
		light1.name = 'ambient_light';
		this.defaultCamera.add(light1);

		const light2 = new DirectionalLight(state.directColor, state.directIntensity);
		light2.position.set(0.5, 0, 0.866); // ~60º
		light2.name = 'main_light';
		this.defaultCamera.add(light2);

		this.lights.push(light1, light2);
	}

	removeLights() {
		this.lights.forEach((light) => light.parent.remove(light));
		this.lights.length = 0;
	}

	updateEnvironment() {
		const environment = environments.filter(
			(entry) => entry.name === this.state.environment,
		)[0];

		this.getCubeMapTexture(environment).then(({ envMap }) => {
			this.scene.environment = envMap;
			this.scene.background = this.state.background ? envMap : this.backgroundColor;
		});
	}

	getCubeMapTexture(environment) {
		const { id, path } = environment;

		// neutral (THREE.RoomEnvironment)
		if (id === 'neutral') {
			return Promise.resolve({ envMap: this.neutralEnvironment });
		}

		// none
		if (id === '') {
			return Promise.resolve({ envMap: null });
		}

		return new Promise((resolve, reject) => {
			new EXRLoader().load(
				path,
				(texture) => {
					const envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
					this.pmremGenerator.dispose();

					resolve({ envMap });
				},
				undefined,
				reject,
			);
		});
	}

	updateDisplay() {
		if (this.skeletonHelpers.length) {
			this.skeletonHelpers.forEach((helper) => this.scene.remove(helper));
		}

		traverseMaterials(this.content, (material) => {
			material.wireframe = this.state.wireframe;

			if (material instanceof PointsMaterial) {
				material.size = this.state.pointSize;
			}
		});

		this.content.traverse((node) => {
			if (node.geometry && node.skeleton && this.state.skeleton) {
				const helper = new SkeletonHelper(node.skeleton.bones[0].parent);
				helper.material.linewidth = 3;
				this.scene.add(helper);
				this.skeletonHelpers.push(helper);
			}
		});

		if (this.state.grid !== Boolean(this.gridHelper)) {
			if (this.state.grid) {
				this.gridHelper = new GridHelper();
				this.axesHelper = new AxesHelper();
				this.axesHelper.renderOrder = 999;
				this.axesHelper.onBeforeRender = (renderer) => renderer.clearDepth();
				this.scene.add(this.gridHelper);
				this.scene.add(this.axesHelper);
			} else {
				this.scene.remove(this.gridHelper);
				this.scene.remove(this.axesHelper);
				this.gridHelper = null;
				this.axesHelper = null;
				this.axesRenderer.clear();
			}
		}

		this.controls.autoRotate = this.state.autoRotate;
	}

	updateBackground() {
		this.backgroundColor.set(this.state.bgColor);
	}

	/**
	 * Adds AxesHelper.
	 *
	 * See: https://stackoverflow.com/q/16226693/1314762
	 */
	addAxesHelper() {
		this.axesDiv = document.createElement('div');
		this.el.appendChild(this.axesDiv);
		this.axesDiv.classList.add('axes');

		const { clientWidth, clientHeight } = this.axesDiv;

		this.axesScene = new Scene();
		this.axesCamera = new PerspectiveCamera(50, clientWidth / clientHeight, 0.1, 10);
		this.axesScene.add(this.axesCamera);

		this.axesRenderer = new WebGLRenderer({ alpha: true });
		this.axesRenderer.setPixelRatio(window.devicePixelRatio);
		this.axesRenderer.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);

		this.axesCamera.up = this.defaultCamera.up;

		this.axesCorner = new AxesHelper(5);
		this.axesScene.add(this.axesCorner);
		this.axesDiv.appendChild(this.axesRenderer.domElement);
	}

	addGUI() {
		const gui = (this.gui = new GUI({
			autoPlace: false,
			width: 260,
			hideable: true,
		}));

		// Display controls.
		const dispFolder = gui.addFolder('Display');
		const envBackgroundCtrl = dispFolder.add(this.state, 'background');
		envBackgroundCtrl.onChange(() => this.updateEnvironment());
		const autoRotateCtrl = dispFolder.add(this.state, 'autoRotate');
		autoRotateCtrl.onChange(() => this.updateDisplay());
		const wireframeCtrl = dispFolder.add(this.state, 'wireframe');
		wireframeCtrl.onChange(() => this.updateDisplay());
		const skeletonCtrl = dispFolder.add(this.state, 'skeleton');
		skeletonCtrl.onChange(() => this.updateDisplay());
		const gridCtrl = dispFolder.add(this.state, 'grid');
		gridCtrl.onChange(() => this.updateDisplay());
		dispFolder.add(this.controls, 'screenSpacePanning');
		const pointSizeCtrl = dispFolder.add(this.state, 'pointSize', 1, 16);
		pointSizeCtrl.onChange(() => this.updateDisplay());
		const bgColorCtrl = dispFolder.addColor(this.state, 'bgColor');
		bgColorCtrl.onChange(() => this.updateBackground());

		// Lighting controls.
		const lightFolder = gui.addFolder('Lighting');
		const envMapCtrl = lightFolder.add(
			this.state,
			'environment',
			environments.map((env) => env.name),
		);
		envMapCtrl.onChange(() => this.updateEnvironment());
		[
			lightFolder.add(this.state, 'toneMapping', {
				Linear: LinearToneMapping,
				'ACES Filmic': ACESFilmicToneMapping,
			}),
			lightFolder.add(this.state, 'exposure', -10, 10, 0.01),
			lightFolder.add(this.state, 'punctualLights').listen(),
			lightFolder.add(this.state, 'ambientIntensity', 0, 2),
			lightFolder.addColor(this.state, 'ambientColor'),
			lightFolder.add(this.state, 'directIntensity', 0, 4), // TODO(#116)
			lightFolder.addColor(this.state, 'directColor'),
		].forEach((ctrl) => ctrl.onChange(() => this.updateLights()));

		// Animation controls.
		this.animFolder = gui.addFolder('Animation');
		this.animFolder.domElement.style.display = 'none';
		const playbackSpeedCtrl = this.animFolder.add(this.state, 'playbackSpeed', 0, 1);
		playbackSpeedCtrl.onChange((speed) => {
			if (this.mixer) this.mixer.timeScale = speed;
		});
		this.animFolder.add({ playAll: () => this.playAllClips() }, 'playAll');

		// Morph target controls.
		this.morphFolder = gui.addFolder('Morph Targets');
		this.morphFolder.domElement.style.display = 'none';

		// Camera controls.
		this.cameraFolder = gui.addFolder('Cameras');
		this.cameraFolder.domElement.style.display = 'none';

		// Stats.
		const perfFolder = gui.addFolder('Performance');
		const perfLi = document.createElement('li');
		this.stats.dom.style.position = 'static';
		perfLi.appendChild(this.stats.dom);
		perfLi.classList.add('gui-stats');
		perfFolder.__ul.appendChild(perfLi);

		const guiWrap = document.createElement('div');
		this.el.appendChild(guiWrap);
		guiWrap.classList.add('gui-wrap');
		guiWrap.appendChild(gui.domElement);
		gui.open();
	}

	updateGUI() {
		this.cameraFolder.domElement.style.display = 'none';

		this.morphCtrls.forEach((ctrl) => ctrl.remove());
		this.morphCtrls.length = 0;
		this.morphFolder.domElement.style.display = 'none';

		this.animCtrls.forEach((ctrl) => ctrl.remove());
		this.animCtrls.length = 0;
		this.animFolder.domElement.style.display = 'none';

		const cameraNames = [];
		const morphMeshes = [];
		this.content.traverse((node) => {
			if (node.geometry && node.morphTargetInfluences) {
				morphMeshes.push(node);
			}
			if (node.isCamera) {
				node.name = node.name || `VIEWER__camera_${cameraNames.length + 1}`;
				cameraNames.push(node.name);
			}
		});

		if (cameraNames.length) {
			this.cameraFolder.domElement.style.display = '';
			if (this.cameraCtrl) this.cameraCtrl.remove();
			const cameraOptions = [DEFAULT_CAMERA].concat(cameraNames);
			this.cameraCtrl = this.cameraFolder.add(this.state, 'camera', cameraOptions);
			this.cameraCtrl.onChange((name) => this.setCamera(name));
		}

		if (morphMeshes.length) {
			this.morphFolder.domElement.style.display = '';
			morphMeshes.forEach((mesh) => {
				if (mesh.morphTargetInfluences.length) {
					const nameCtrl = this.morphFolder.add(
						{ name: mesh.name || 'Untitled' },
						'name',
					);
					this.morphCtrls.push(nameCtrl);
				}
				for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
					const ctrl = this.morphFolder
						.add(mesh.morphTargetInfluences, i, 0, 1, 0.01)
						.listen();
					Object.keys(mesh.morphTargetDictionary).forEach((key) => {
						if (key && mesh.morphTargetDictionary[key] === i) ctrl.name(key);
					});
					this.morphCtrls.push(ctrl);
				}
			});
		}

		if (this.clips.length) {
			this.animFolder.domElement.style.display = '';
			const actionStates = (this.state.actionStates = {});
			this.clips.forEach((clip, clipIndex) => {
				clip.name = `${clipIndex + 1}. ${clip.name}`;

				// Autoplay the first clip.
				let action;
				if (clipIndex === 0) {
					actionStates[clip.name] = true;
					action = this.mixer.clipAction(clip);
					action.play();
				} else {
					actionStates[clip.name] = false;
				}

				// Play other clips when enabled.
				const ctrl = this.animFolder.add(actionStates, clip.name).listen();
				ctrl.onChange((playAnimation) => {
					action = action || this.mixer.clipAction(clip);
					action.setEffectiveTimeScale(1);
					playAnimation ? action.play() : action.stop();
				});
				this.animCtrls.push(ctrl);
			});
		}
	}

	clear() {
		if (!this.content) return;

		this.scene.remove(this.content);

		// dispose geometry
		this.content.traverse((node) => {
			if (!node.geometry) return;

			node.geometry.dispose();
		});

		// dispose textures
		traverseMaterials(this.content, (material) => {
			for (const key in material) {
				if (key !== 'envMap' && material[key] && material[key].isTexture) {
					material[key].dispose();
				}
			}
		});
	}
}

function traverseMaterials(object, callback) {
	object.traverse((node) => {
		if (!node.geometry) return;
		const materials = Array.isArray(node.material) ? node.material : [node.material];
		materials.forEach(callback);
	});
}

// https://stackoverflow.com/a/9039885/1314762
function isIOS() {
	return (
		['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'].includes(
			navigator.platform,
		) ||
		// iPad on iOS 13 detection
		(navigator.userAgent.includes('Mac') && 'ontouchend' in document)
	);
}
